# Cloud Run uses the service container port configured at deployment time.
# Keep it at 50021 to match VOICEVOX Engine's public HTTP API.
FROM voicevox/voicevox_engine:cpu-ubuntu24.04-latest

# The Worker, not browsers, will be the future caller.  Disable VOICEVOX APIs
# that mutate Engine settings or dictionaries, and avoid oversubscribing the
# initial one-vCPU Cloud Run service.
ENV VV_HOST=0.0.0.0 \
    VV_PORT=50021 \
    VV_CPU_NUM_THREADS=1 \
    VV_DISABLE_MUTABLE_API=1

EXPOSE 50021
