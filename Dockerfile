FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    # git \
    # unzip \
    python3 \
    python-is-python3 \
    python3-pip \
    # tmux \
    xvfb \
    xauth \
    libgl1-mesa-dev \
    libgles2-mesa-dev \
    libosmesa6-dev \
    build-essential \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    libxi-dev \
    libxinerama-dev \
    libxrandr-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json .
COPY patches ./patches
COPY scripts/verify_patch.js ./scripts/
RUN npm install

COPY . .

CMD ["npm", "start"]
