ARG BUILD_FROM
FROM ${BUILD_FROM}

# Python + aiohttp from Alpine packages - no pip needed.
RUN apk add --no-cache python3 py3-aiohttp

# Bundle Material Design Icons and hls.js (live camera video) so the dashboard never
# needs the internet at runtime.
ARG MDI_VERSION=7.4.47
ARG HLS_VERSION=1.5.20
RUN apk add --no-cache --virtual .fetch curl tar \
    && mkdir -p /tmp/mdi /tmp/hls /app/static/vendor/mdi /app/static/vendor/hls \
    && curl -fsSL "https://registry.npmjs.org/@mdi/font/-/font-${MDI_VERSION}.tgz" \
       | tar -xz -C /tmp/mdi \
    && cp -r /tmp/mdi/package/css /tmp/mdi/package/fonts /app/static/vendor/mdi/ \
    && curl -fsSL "https://registry.npmjs.org/hls.js/-/hls.js-${HLS_VERSION}.tgz" \
       | tar -xz -C /tmp/hls \
    && cp /tmp/hls/package/dist/hls.min.js /app/static/vendor/hls/ \
    && rm -rf /tmp/mdi /tmp/hls \
    && apk del .fetch

COPY app/server.py app/demo.py app/errors.py /app/
COPY app/static/ /app/static/
COPY run.sh /run.sh
RUN chmod a+x /run.sh

CMD [ "/run.sh" ]
