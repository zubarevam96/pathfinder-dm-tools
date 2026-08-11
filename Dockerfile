# The site used to be static on GitHub Pages. It runs as a container now so
# that it and the bot's API share one origin — see app.py's module docstring
# for why that was worth a server.
FROM python:3.13-slim

WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

# Copied first so a change to the site doesn't reinstall Python packages.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py accounts.py oidc.py ./
COPY static ./static

# Railway injects PORT and routes the generated domain at it. The default is
# for running the image locally, where nothing injects anything.
ENV PORT=8080
EXPOSE 8080

# gunicorn, not `flask run`: the development server is single-threaded and says
# so itself on every boot. Two workers because /sync/* blocks on the bot for
# the length of the upstream call, and one worker would serve the site to
# nobody else while it waited.
CMD ["sh", "-c", "exec gunicorn --bind 0.0.0.0:${PORT} --workers 2 --timeout 30 --access-logfile - app:app"]
