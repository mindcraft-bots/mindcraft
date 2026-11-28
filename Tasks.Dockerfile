FROM node:22-bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python-is-python3 xvfb xauth libgl1-mesa-dev libgles2-mesa-dev \
    libosmesa6-dev build-essential libcairo2-dev libpango1.0-dev libjpeg-dev \
    libgif-dev librsvg2-dev libxi-dev libxinerama-dev libxrandr-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
COPY ci/npm-lock.json ./package-lock.json
COPY patches ./patches
COPY scripts/verify_patch.js ./scripts/
# Keep the CI lock separate from the developer's ignored root lockfile.
RUN npm ci
COPY . .
CMD ["python3", "tasks/run_task_file.py", "--task_path", "tasks/schematics_test.json"]
