# Reviewed Docker Official Image, node:22-bookworm-slim, manifest digest.
FROM node@sha256:be979e5523c76fa4d5ca4ebd3099078f220aa47ec39c48ad5b5df9314debd6eb

# Pin direct runtime packages. The inspected final image ID also identifies all
# transitive packages and native libraries installed by Debian.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3=3.11.2-1+b1 python3.11=3.11.2-6+deb12u9 python3-numpy=1:1.24.2-1+deb12u1 \
    && rm -rf /var/lib/apt/lists/*
RUN node -e "const https=require('https'),fs=require('fs'),crypto=require('crypto');https.get('https://files.pythonhosted.org/packages/7f/10/5669f4e5fa24706fa44b2e28e4362429665a8d26f3c18eda7233f1a01772/nbtlib-2.0.4-py3-none-any.whl',r=>{if(r.statusCode!==200)throw Error('download '+r.statusCode);const a=[];r.on('data',x=>a.push(x));r.on('end',()=>{const b=Buffer.concat(a);if(crypto.createHash('sha256').update(b).digest('hex')!=='38d571fbf2f7ebd640639461b47fc79919a8ea8e74633ffcc8aa6b2acfc9c889')throw Error('wheel checksum');fs.writeFileSync('/tmp/nbtlib.whl',b)})}).on('error',e=>{throw e})" \
    && python3 -m zipfile -e /tmp/nbtlib.whl /usr/local/lib/python3.11/dist-packages \
    && rm /tmp/nbtlib.whl \
    && python3 -c 'import nbtlib,numpy; assert nbtlib.__version__ == "2.0.4" and numpy.__version__ == "1.24.2"'
LABEL org.mindcraft.schematic-compiler="1"
