# Keycloak, as a third Railway service in the same project.
#
# Two stages because Keycloak wants its build step done at image-build time, not
# at boot: `kc.sh build` bakes the chosen database vendor and features into the
# distribution, and `start --optimized` then refuses to re-derive any of it. A
# single-stage image would repeat that work on every cold start, which on a
# service that sleeps is the difference between a slow login and a timed-out one.
FROM quay.io/keycloak/keycloak:26.7.1 AS builder

# Build-time only. The URL, credentials and hostname are runtime concerns and
# deliberately not baked in — see railway.toml's notes.
ENV KC_DB=postgres
ENV KC_HEALTH_ENABLED=true

RUN /opt/keycloak/bin/kc.sh build

FROM quay.io/keycloak/keycloak:26.7.1

COPY --from=builder /opt/keycloak/ /opt/keycloak/

# Imported on first start only. Keycloak skips a realm that already exists, so
# this file is the *initial* shape of the realm, not a spec that keeps being
# enforced — edit the realm in the admin console after that, and re-export here
# if the change is worth keeping.
COPY realm-pathfinder.json /opt/keycloak/data/import/realm-pathfinder.json

ENTRYPOINT ["/opt/keycloak/bin/kc.sh"]
CMD ["start", "--optimized", "--import-realm"]
