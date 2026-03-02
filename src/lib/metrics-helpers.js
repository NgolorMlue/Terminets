export function formatUpdatedAgo(ms) {
  if (!ms) return 'Never';
  const seconds = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (seconds < 5) return 'Just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function shortErrorText(value) {
  const text = String(value || 'Unknown error').replace(/\s+/g, ' ').trim();
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function inferBrowserScheme(port) {
  if ([443, 6443, 8443, 9443].includes(port)) return 'https';
  if ([80, 81, 3000, 3001, 4000, 5000, 5173, 5601, 8000, 8080, 8081, 8088, 8888, 9000, 9090, 9200, 15672].includes(port)) return 'http';
  return '';
}

export function normalizeUrlHost(host) {
  const raw = String(host || '').trim();
  if (!raw) return '';
  if (raw.startsWith('[') && raw.endsWith(']')) return raw;
  if (raw.includes(':')) return `[${raw}]`;
  return raw;
}

export function buildServiceBrowserUrl(server, service) {
  if (!service?.is_browser_supported) return '';
  const host = normalizeUrlHost(server?.host || '');
  const port = Number(service?.port);
  if (!host || !Number.isFinite(port) || port <= 0) return '';
  const scheme = String(service?.browser_url_scheme || inferBrowserScheme(port)).toLowerCase();
  if (!scheme) return '';
  const omitPort = (scheme === 'http' && port === 80) || (scheme === 'https' && port === 443);
  return `${scheme}://${host}${omitPort ? '' : `:${port}`}/`;
}

export function renderMetricsServiceRows(server, services) {
  if (!Array.isArray(services) || !services.length) {
    return '<div class="mx-service-empty">No listening services found in latest scan.</div>';
  }

  return services
    .slice()
    .sort((a, b) => Number(a?.port || 0) - Number(b?.port || 0))
    .slice(0, 24)
    .map((service) => {
      const port = Number(service?.port || 0);
      const protocol = String(service?.protocol || 'tcp').toUpperCase();
      const bind = String(service?.bind || '*');
      const serviceName = escapeHtml(String(service?.service || `Port ${port || '?'}`));
      const openUrl = buildServiceBrowserUrl(server, service);
      const encodedUrl = openUrl ? encodeURIComponent(openUrl) : '';
      const processName = String(service?.process || '').trim();
      const processMeta = processName ? ` · ${escapeHtml(processName)}` : '';
      const meta = `${escapeHtml(protocol)} · ${escapeHtml(bind)}:${port || '?'}${processMeta}`;

      return `
        <div class="mx-service-item">
          <div class="mx-service-main">
            <div class="mx-service-name">${serviceName}</div>
            <div class="mx-service-meta">${meta}</div>
          </div>
          ${openUrl
            ? `<button class="mx-service-open-btn" data-open-url="${encodedUrl}" title="Open ${serviceName}">Open</button>`
            : '<span class="mx-service-chip">Non-web</span>'}
        </div>`;
    })
    .join('');
}

export function renderSensitiveValue(value, kind = 'text', masked = false) {
  const raw = String(value ?? '\u2014');
  const normalized = raw.trim().toLowerCase();
  if (
    !masked
    || !raw.trim()
    || raw.trim() === '\u2014'
    || normalized === 'unavailable'
    || normalized === 'unknown'
  ) {
    return escapeHtml(raw);
  }
  if (kind === 'coordinates') return '\u2022\u2022.\u2022\u2022\u2022\u2022, \u2022\u2022.\u2022\u2022\u2022\u2022';
  return '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';
}

export function seedFromServer(server) {
  const input = `${server.id}|${server.name}|${server.loc}|${server.lat}|${server.lng}`;
  let hash = 7;
  for (let i = 0; i < input.length; i += 1) hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  return hash;
}

export function seededInt(seed, offset, min, max) {
  const x = Math.sin(seed + offset) * 10000;
  const unit = x - Math.floor(x);
  return Math.floor(unit * (max - min + 1)) + min;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function seededSeries(seed, offset, points, min, max, wobble = 7) {
  const series = [];
  const span = Math.max(1, max - min);
  let current = seededInt(seed, offset, min, max);
  for (let i = 0; i < points; i += 1) {
    const drift = seededInt(seed + offset * 97, i + 1, -wobble, wobble);
    const pull = seededInt(seed + offset * 17, i + 53, -2, 2);
    current = clamp(current + drift + pull, min, max);
    const previous = i > 0 ? series[i - 1] : current;
    series.push(Math.round((previous * 0.45) + (current * 0.55)));
  }
  if (Math.max(...series) - Math.min(...series) < Math.max(3, span * 0.06)) {
    return series.map((value, index) => clamp(value + ((index % 3) - 1) * 2, min, max));
  }
  return series;
}

export function seriesAvg(values) {
  return Math.round(values.reduce((acc, value) => acc + value, 0) / values.length);
}

export function sparklineSvg(values, color) {
  const width = 240;
  const height = 64;
  const pad = 6;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const xStep = (width - pad * 2) / Math.max(1, values.length - 1);
  const yScale = (height - pad * 2) / Math.max(1, max - min);
  const points = values.map((value, index) => {
    const x = pad + index * xStep;
    const y = height - pad - ((value - min) * yScale);
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const area = `${points.join(' ')} ${(width - pad).toFixed(2)},${(height - pad).toFixed(2)} ${pad.toFixed(2)},${(height - pad).toFixed(2)}`;
  const [lastX, lastY] = points[points.length - 1].split(',');

  return `
    <svg class="mx-spark-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
      <polyline class="mx-spark-grid" points="${pad},${height * 0.22} ${width - pad},${height * 0.22}"></polyline>
      <polyline class="mx-spark-grid" points="${pad},${height * 0.50} ${width - pad},${height * 0.50}"></polyline>
      <polyline class="mx-spark-grid" points="${pad},${height * 0.78} ${width - pad},${height * 0.78}"></polyline>
      <polygon points="${area}" fill="${color}22"></polygon>
      <polyline points="${points.join(' ')}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"></polyline>
      <circle cx="${lastX}" cy="${lastY}" r="3.6" fill="${color}"></circle>
    </svg>`;
}

export function buildAttentionIssues({
  cpu,
  ram,
  disk,
  statusReason,
}) {
  const issues = [];

  if (cpu !== null && cpu >= 85) issues.push({ severity: 'bad', message: `CPU usage is high at ${cpu}%.` });
  else if (cpu !== null && cpu >= 70) issues.push({ severity: 'warn', message: `CPU usage is elevated at ${cpu}%.` });

  if (ram !== null && ram >= 90) issues.push({ severity: 'bad', message: `Memory pressure is critical at ${ram}%.` });
  else if (ram !== null && ram >= 75) issues.push({ severity: 'warn', message: `Memory usage is high at ${ram}%.` });

  if (disk !== null && disk >= 90) issues.push({ severity: 'bad', message: `Disk usage is critical at ${disk}%.` });
  else if (disk !== null && disk >= 80) issues.push({ severity: 'warn', message: `Disk usage is high at ${disk}%.` });

  if (typeof statusReason === 'string' && statusReason.trim()) {
    issues.push({ severity: 'warn', message: `Connectivity note: ${statusReason.trim()}` });
  }

  if (!issues.length) {
    issues.push({ severity: 'ok', message: 'No active attention issues detected.' });
  }

  return issues;
}
