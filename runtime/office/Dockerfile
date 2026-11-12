FROM python:3.12.13-slim-bookworm@sha256:4766d8b510c428e595d74b9cc5bbb2fae8e26316fffb4adc89908d79aacd58a2 AS pyuno
WORKDIR /build
COPY runtime/office/runtime.lock.json runtime/office/fetch_pyuno.py ./
RUN python fetch_pyuno.py /overlay

FROM collabora/code:26.04.6.1.1@sha256:95f29f1c0a1778999125f53f058d968fe0afb37c95e32ebfb9f3444140faebd2
# Adds the vendor's matching Python/UNO bridge, no second Office core or pip stack.
COPY --from=pyuno /overlay/opt/collaboraoffice/ /opt/collaboraoffice/
COPY --from=pyuno /overlay/licenses/ /app/licenses/
COPY runtime/office/ /app/
ENV HOME=/tmp SAL_USE_VCLPLUGIN=svp PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    HYPER_OFFICE_BIND_HOST=0.0.0.0 \
    LD_LIBRARY_PATH=/opt/collaboraoffice/program \
    URE_BOOTSTRAP=vnd.sun.star.pathname:/opt/collaboraoffice/program/fundamentalrc \
    PYTHONHOME=/opt/collaboraoffice/program/python-core-3.14.10 \
    PYTHONPATH=/opt/collaboraoffice/program:/opt/collaboraoffice/program/python-core-3.14.10/lib:/opt/collaboraoffice/program/python-core-3.14.10/lib/lib-dynload
RUN ["/opt/collaboraoffice/program/python.bin", "/app/verify_runtime.py"]
WORKDIR /app
USER 10001:10001
HEALTHCHECK NONE
EXPOSE 3123
ENTRYPOINT ["/opt/collaboraoffice/program/python.bin", "/app/service.py"]
