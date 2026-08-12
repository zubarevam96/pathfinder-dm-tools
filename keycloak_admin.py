"""Creating a Keycloak user, for the one caller allowed to ask: the bot.

Signing in is ``oidc.py``'s job and uses the ``pathfinder-web`` client. This is
the other direction — making an account that nobody has signed into yet — and
it deliberately uses a *different* client, ``pathfinder-bot``, whose service
account holds ``manage-users`` and nothing else. Two clients rather than one
because the login client is public-facing in the sense that matters: its secret
is used on every sign-in, and a client that can also mint users is a client
whose compromise is worse.

The realm has ``registrationAllowed: false``, so this is the only way in
besides an administrator making one by hand. That is the intent: an account
here is something the bot vouches for, having already established who is asking
and that they run a table.

The password is temporary in Keycloak's own sense — the account carries an
``UPDATE_PASSWORD`` required action, so whatever travelled through a chat log
stops working the first time it is used properly.
"""

from __future__ import annotations

import secrets
import string
import time
from urllib.parse import urlsplit

import requests

#: Requests to Keycloak. Somebody is watching a Telegram chat for the answer.
TIMEOUT_SECONDS = 10

#: How long a service-account token is reused before another is asked for.
#: Keycloak's default access token lifespan is 300s; stopping well short of it
#: means a token is never spent at the moment it expires.
TOKEN_MARGIN_SECONDS = 30

#: Where a generated password is drawn from. No look-alikes: it is read off one
#: screen and typed into another, exactly like a pairing code.
PASSWORD_ALPHABET = string.ascii_lowercase.replace("l", "").replace("o", "") + "23456789"

#: Long enough that it is not worth guessing in the window before it is changed.
PASSWORD_LENGTH = 16


class AdminError(Exception):
    """Keycloak refused, in words worth passing back to whoever asked."""


class EmailTaken(AdminError):
    """That address already has an account. A distinct case: it is actionable."""


def temporary_password() -> str:
    """A password meant to be typed once and replaced."""
    return "".join(secrets.choice(PASSWORD_ALPHABET) for _ in range(PASSWORD_LENGTH))


class Admin:
    """The realm's user-creating half, authenticated as a service account."""

    def __init__(self, issuer: str, client_id: str, client_secret: str) -> None:
        self.issuer = issuer.rstrip("/")
        self.client_id = client_id
        self.client_secret = client_secret
        self._token = ""
        self._token_expires_at = 0.0

    @property
    def configured(self) -> bool:
        """Whether registration is possible at all.

        The site has to keep working with no Keycloak in front of it -- that is
        how it runs in local dev -- so every caller checks this first rather
        than discovering it as a connection error.
        """
        return bool(self.issuer and self.client_id and self.client_secret)

    # -- addresses -----------------------------------------------------------

    @property
    def realm(self) -> str:
        """The realm name, taken from the issuer rather than configured twice."""
        return self.issuer.rsplit("/realms/", 1)[-1].strip("/")

    @property
    def base(self) -> str:
        """``https://host/admin/realms/<realm>``, derived the same way."""
        split = urlsplit(self.issuer)
        return f"{split.scheme}://{split.netloc}/admin/realms/{self.realm}"

    # -- the service account -------------------------------------------------

    def token(self) -> str:
        """A service-account access token, reused until it is nearly spent."""
        now = time.time()
        if self._token and now < self._token_expires_at:
            return self._token
        try:
            response = requests.post(
                f"{self.issuer}/protocol/openid-connect/token",
                data={
                    "grant_type": "client_credentials",
                    "client_id": self.client_id,
                    "client_secret": self.client_secret,
                },
                timeout=TIMEOUT_SECONDS,
            )
        except requests.RequestException as error:
            raise AdminError(f"Couldn't reach the accounts service: {error}") from error
        if response.status_code != 200:
            raise AdminError("The accounts service refused this service's own credentials.")
        try:
            payload = response.json()
        except ValueError as error:
            raise AdminError("The accounts service returned something that wasn't JSON.") from error

        token = payload.get("access_token")
        if not isinstance(token, str) or not token:
            raise AdminError("The accounts service issued no token.")
        lifetime = payload.get("expires_in")
        seconds = lifetime if isinstance(lifetime, int) else 60
        self._token = token
        self._token_expires_at = now + max(seconds - TOKEN_MARGIN_SECONDS, 5)
        return token

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.token()}", "Content-Type": "application/json"}

    # -- making one ----------------------------------------------------------

    def create_user(self, email: str, *, display_name: str | None = None) -> tuple[str, str]:
        """Create an enabled user with a temporary password. Returns (subject, password).

        The realm sets ``registrationEmailAsUsername``, so the address is both.
        ``emailVerified`` is left false: nothing here has proved the address,
        and saying otherwise would be this service asserting something it does
        not know.
        """
        if not self.configured:
            raise AdminError("Accounts aren't configured on this deployment.")

        password = temporary_password()
        body: dict[str, object] = {
            "username": email,
            "email": email,
            "enabled": True,
            "emailVerified": False,
            "requiredActions": ["UPDATE_PASSWORD"],
            "credentials": [{"type": "password", "value": password, "temporary": True}],
        }
        if display_name:
            # One field, split the way Keycloak wants it, because the account
            # console shows a bare username otherwise.
            first, _, last = display_name.strip().partition(" ")
            body["firstName"] = first
            if last:
                body["lastName"] = last

        try:
            response = requests.post(
                f"{self.base}/users", json=body, headers=self._headers(), timeout=TIMEOUT_SECONDS
            )
        except requests.RequestException as error:
            raise AdminError(f"Couldn't reach the accounts service: {error}") from error

        if response.status_code == 409:
            raise EmailTaken("That email already has an account. Sign in instead.")
        if response.status_code not in (201, 204):
            raise AdminError("The accounts service wouldn't create that account.")

        return self._subject_of(response, email), password

    def _subject_of(self, response: requests.Response, email: str) -> str:
        """The new user's id, from the Location header Keycloak answers with.

        Falling back to a lookup by email covers a Keycloak that answered 201
        without the header -- rare, but the id is what the account is *keyed*
        by here, so guessing is not an option.
        """
        location = response.headers.get("Location") or ""
        subject = location.rstrip("/").rsplit("/", 1)[-1]
        if subject and subject != location.rstrip("/"):
            return subject
        return self.subject_for_email(email)

    def subject_for_email(self, email: str) -> str:
        """Look a user's id up by their address."""
        try:
            response = requests.get(
                f"{self.base}/users",
                params={"email": email, "exact": "true"},
                headers=self._headers(),
                timeout=TIMEOUT_SECONDS,
            )
            response.raise_for_status()
            found = response.json()
        except (requests.RequestException, ValueError) as error:
            raise AdminError(f"Couldn't confirm the new account: {error}") from error

        if not isinstance(found, list) or not found:
            raise AdminError("The account was created but couldn't be found again.")
        subject = found[0].get("id")
        if not isinstance(subject, str) or not subject:
            raise AdminError("The accounts service returned a user with no id.")
        return subject
