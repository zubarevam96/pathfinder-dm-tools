"""The OpenID Connect half of signing in, spoken to Keycloak.

The browser never sees a token. This service runs the authorization-code flow
itself, keeps the tokens in the account store, and gives the browser nothing but
an HttpOnly session cookie — the pattern usually called a backend-for-frontend.

That is worth the extra server code. The alternative for a page with no build
step is a token in ``localStorage``, readable by any script that ever gets onto
the page, and a refresh token there is a permanent one. A cookie the page cannot
read is not, and the site already has a server in front of it for ``/sync/*``.

PKCE is used anyway, on a *confidential* client that also authenticates with a
secret. Belt and braces: the secret protects the token endpoint, and the
verifier protects against an authorization code intercepted on the way back.

**The ID token's signature is not verified, on purpose.** It arrives on this
server's own TLS connection to the token endpoint, in the response to a request
this service authenticated with its client secret — OIDC Core §3.1.3.7 excuses
signature validation in exactly that case, because the channel already proves
who sent it. What is *not* excused, and is checked below, is the claim content:
issuer, audience, expiry and nonce. Skipping those would be the actual hole.
"""

from __future__ import annotations

import base64
import hashlib
import json
import secrets
import time
from urllib.parse import urlencode

import requests

#: How long to trust a cached discovery document. Keycloak's endpoints move only
#: when the realm is renamed, but pinning it forever means a rename needs a
#: redeploy to notice.
DISCOVERY_TTL_SECONDS = 3600

#: Requests to Keycloak. Short, because every one of them is inside a page load
#: somebody is waiting on.
TIMEOUT_SECONDS = 10

#: Clock skew allowed when checking ``exp``. Two containers on one host still
#: disagree by milliseconds; a minute is the usual allowance.
LEEWAY_SECONDS = 60


class OidcError(Exception):
    """Anything that went wrong talking to Keycloak, in words a page can show."""


class Client:
    """One Keycloak realm and one client registration."""

    def __init__(self, issuer: str, client_id: str, client_secret: str) -> None:
        self.issuer = issuer.rstrip("/")
        self.client_id = client_id
        self.client_secret = client_secret
        self._discovery: dict | None = None
        self._discovered_at = 0.0

    @property
    def configured(self) -> bool:
        """Whether signing in is possible at all.

        Everything auth-shaped checks this first: the site has to keep working
        with no Keycloak in front of it, because that is exactly how it runs in
        local dev and how it ran for its whole life until now.
        """
        return bool(self.issuer and self.client_id and self.client_secret)

    # -- discovery -----------------------------------------------------------

    def metadata(self) -> dict:
        now = time.time()
        if self._discovery is None or now - self._discovered_at > DISCOVERY_TTL_SECONDS:
            url = f"{self.issuer}/.well-known/openid-configuration"
            try:
                response = requests.get(url, timeout=TIMEOUT_SECONDS)
                response.raise_for_status()
                self._discovery = response.json()
            except requests.RequestException as error:
                raise OidcError(f"Couldn't reach the sign-in service: {error}") from error
            except ValueError as error:
                raise OidcError("The sign-in service returned something that wasn't JSON.") from error
            self._discovered_at = now
        return self._discovery

    def endpoint(self, name: str) -> str:
        url = self.metadata().get(name)
        if not url:
            raise OidcError(f"The sign-in service advertises no {name}.")
        return url

    # -- the redirect out ----------------------------------------------------

    def authorization_url(
        self, redirect_uri: str, state: str, nonce: str, verifier: str, action: str | None = None
    ) -> str:
        """Where to send the browser to sign in.

        ``action`` is Keycloak's application-initiated actions: passing
        ``UPDATE_PASSWORD`` sends someone to Keycloak's own change-password form
        and returns them here afterwards. That is why this service has no
        password field of its own and never handles a password — the one screen
        that could is Keycloak's, on Keycloak's origin.
        """
        challenge = base64.urlsafe_b64encode(
            hashlib.sha256(verifier.encode("ascii")).digest()
        ).rstrip(b"=").decode("ascii")
        params = {
            "client_id": self.client_id,
            "response_type": "code",
            "scope": "openid profile email",
            "redirect_uri": redirect_uri,
            "state": state,
            "nonce": nonce,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
        }
        if action:
            params["kc_action"] = action
        return f"{self.endpoint('authorization_endpoint')}?{_query(params)}"

    def end_session_url(self, id_token: str | None, redirect_uri: str) -> str:
        params = {"post_logout_redirect_uri": redirect_uri, "client_id": self.client_id}
        if id_token:
            params["id_token_hint"] = id_token
        return f"{self.endpoint('end_session_endpoint')}?{_query(params)}"

    # -- the token endpoint --------------------------------------------------

    def exchange_code(self, code: str, redirect_uri: str, verifier: str) -> dict:
        return self._token_request(
            {
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": redirect_uri,
                "code_verifier": verifier,
            }
        )

    def refresh(self, refresh_token: str) -> dict:
        return self._token_request(
            {"grant_type": "refresh_token", "refresh_token": refresh_token}
        )

    def _token_request(self, data: dict) -> dict:
        payload = dict(data)
        payload["client_id"] = self.client_id
        payload["client_secret"] = self.client_secret
        try:
            response = requests.post(
                self.endpoint("token_endpoint"), data=payload, timeout=TIMEOUT_SECONDS
            )
        except requests.RequestException as error:
            raise OidcError(f"Couldn't reach the sign-in service: {error}") from error
        if response.status_code >= 400:
            raise OidcError(_token_error(response))
        try:
            return response.json()
        except ValueError as error:
            raise OidcError("The sign-in service returned something that wasn't JSON.") from error

    # -- claims --------------------------------------------------------------

    def claims_of(self, id_token: str, nonce: str | None) -> dict:
        """The ID token's payload, once it has been checked over.

        See the module docstring for why the signature is not among the checks.
        """
        claims = decode_segment(id_token)

        issuer = claims.get("iss")
        if issuer and issuer.rstrip("/") != self.issuer:
            raise OidcError("That sign-in came from the wrong place.")

        audience = claims.get("aud")
        audiences = audience if isinstance(audience, list) else [audience]
        if self.client_id not in audiences:
            raise OidcError("That sign-in was issued for a different application.")

        expires = claims.get("exp")
        if isinstance(expires, (int, float)) and expires + LEEWAY_SECONDS < time.time():
            raise OidcError("That sign-in had already expired. Try again.")

        # Only present on a fresh authorization; a refresh reissues the ID token
        # without one, which is why the caller passes None there.
        if nonce is not None and claims.get("nonce") != nonce:
            raise OidcError("That sign-in didn't match the one that was started here.")

        return claims


def decode_segment(token: str) -> dict:
    """The payload of a JWT, without verifying anything.

    Named to say so. Every caller either has a channel that already proved the
    token's origin, or is only reading a hint it does not act on.
    """
    parts = token.split(".")
    if len(parts) < 2:
        raise OidcError("That wasn't a token.")
    padded = parts[1] + "=" * (-len(parts[1]) % 4)
    try:
        return json.loads(base64.urlsafe_b64decode(padded))
    except (ValueError, TypeError) as error:
        raise OidcError("That token's contents couldn't be read.") from error


def new_verifier() -> str:
    """A PKCE code verifier: 43-128 characters of unreserved ASCII (RFC 7636)."""
    return secrets.token_urlsafe(64)


def _query(params: dict) -> str:
    return urlencode({k: v for k, v in params.items() if v is not None})


def _token_error(response: requests.Response) -> str:
    """Keycloak's reason for refusing, if it gave one worth repeating."""
    try:
        body = response.json()
    except ValueError:
        return f"The sign-in service refused with {response.status_code}."
    description = body.get("error_description") or body.get("error")
    if description:
        return f"Sign-in failed: {description}"
    return f"The sign-in service refused with {response.status_code}."
