# Linux check: a clean Debian with Node 22. Runs the smoke test and a real install (no systemd in a container, so --service none).
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl git poppler-utils fontconfig rsync systemd ca-certificates && rm -rf /var/lib/apt/lists/*
RUN useradd -m tester
USER tester
WORKDIR /home/tester/src
COPY --chown=tester . .
RUN npm ci --omit=dev --no-audit --no-fund
CMD ["bash", "test/linux/run.sh"]
