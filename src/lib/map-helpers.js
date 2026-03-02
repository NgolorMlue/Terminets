export function sDot(status) {
  return status === 'online' ? '#00ffaa' : status === 'warn' ? '#f5a623' : status === 'unknown' ? '#3a5570' : '#ff3b5c';
}

export function latencyColor(latencyMs, status) {
  if (typeof latencyMs !== 'number' || !Number.isFinite(latencyMs)) {
    return status === 'offline' ? 'var(--danger)' : 'var(--muted)';
  }
  if (latencyMs < 20) return '#f7fbff';
  if (latencyMs < 90) return '#00ffaa';
  if (latencyMs < 120) return '#c8ff4d';
  if (latencyMs < 150) return '#ffd84d';
  if (latencyMs < 200) return '#ff9f1a';
  return '#ff3b5c';
}

export function normalizeCoordinate(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function getServerMapCoords(server) {
  const lat = Number(server?.lat);
  const lng = Number(server?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

export function hasValidMapCoords(server) {
  return Boolean(getServerMapCoords(server));
}

export function safeMapFlyTo(mapInstance, coords, minZoom = 3) {
  if (!mapInstance || !coords) return;

  const rawZoom = Number(mapInstance.getZoom?.());
  const targetZoom = Number.isFinite(rawZoom) ? Math.max(rawZoom, minZoom) : minZoom;
  const fly = () => {
    try {
      mapInstance.flyTo([coords.lat, coords.lng], targetZoom, { duration: 0.8 });
    } catch (error) {
      console.warn('Map flyTo skipped due to invalid map state:', error);
    }
  };

  mapInstance.invalidateSize();
  const size = mapInstance.getSize?.();
  const hasSize = size && Number.isFinite(size.x) && Number.isFinite(size.y) && size.x > 0 && size.y > 0;

  if (!hasSize) {
    setTimeout(() => {
      mapInstance.invalidateSize();
      const retrySize = mapInstance.getSize?.();
      const retryHasSize = retrySize
        && Number.isFinite(retrySize.x)
        && Number.isFinite(retrySize.y)
        && retrySize.x > 0
        && retrySize.y > 0;
      if (retryHasSize) fly();
    }, 160);
    return;
  }

  fly();
}
