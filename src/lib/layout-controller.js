export function createLayoutController({
  map,
  updateMainTerminalLayout,
  getSelectedServerId,
}) {
  let sidebarCollapsed = false;
  let mapCollapsed = false;
  let mapHeightBeforeCollapse = '50%';
  let isMaximized = false;
  let preMax = { mapCollapsed: false, mapHeight: null };

  function toggleSidebarCollapse() {
    const sidebar = document.getElementById('sidebar');
    const arrow = document.getElementById('sb-toggle-arrow');
    const label = document.querySelector('.sb-toggle-label');
    sidebarCollapsed = !sidebarCollapsed;
    sidebar.classList.toggle('collapsed', sidebarCollapsed);
    arrow.textContent = sidebarCollapsed ? '\u203a' : '\u2039';
    if (label) label.textContent = sidebarCollapsed ? 'EXPAND' : 'COLLAPSE';
    setTimeout(() => { map.invalidateSize(); }, 250);
  }

  function toggleSidebar(force) {
    if (window.innerWidth > 700) return;
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    const isOpen = force !== undefined ? force : !sidebar.classList.contains('open');
    sidebar.classList.toggle('open', isOpen);
    overlay.classList.toggle('open', isOpen);
  }

  function refreshRailActive() {
    document.querySelectorAll('.sb-rail-item').forEach((element) => element.classList.remove('active'));
    const selectedServerId = getSelectedServerId();
    if (selectedServerId !== null) {
      document.getElementById(`rail-${selectedServerId}`)?.classList.add('active');
    }
  }

  function toggleMap() {
    const mapSection = document.getElementById('map-section');
    const button = document.getElementById('map-toggle-btn');
    mapCollapsed = !mapCollapsed;
    if (mapCollapsed) {
      mapHeightBeforeCollapse = mapSection.style.height || '50%';
      mapSection.classList.add('collapsed');
      button.textContent = '\u25b8 Expand';
    } else {
      mapSection.classList.remove('collapsed');
      mapSection.style.height = mapHeightBeforeCollapse;
      button.textContent = '\u25be Collapse';
      setTimeout(() => { map.invalidateSize(); }, 260);
    }
  }

  function toggleMaximize() {
    const button = document.getElementById('tab-maximize-btn');
    const icon = document.getElementById('maximize-icon');
    const label = document.getElementById('maximize-label');

    if (!isMaximized) {
      preMax.mapCollapsed = mapCollapsed;
      preMax.mapHeight = document.getElementById('map-section').style.height || null;

      if (!mapCollapsed) {
        mapCollapsed = true;
        const mapSection = document.getElementById('map-section');
        if (!preMax.mapHeight) preMax.mapHeight = mapSection.style.height || null;
        mapSection.classList.add('collapsed');
        document.getElementById('map-toggle-btn').textContent = '\u25b8 Expand';
      }

      isMaximized = true;
      button.classList.add('maximized');
      icon.textContent = '\u2921';
      label.textContent = 'MIN';
      updateMainTerminalLayout();
      setTimeout(() => { map.invalidateSize(); }, 260);
      return;
    }

    if (!preMax.mapCollapsed && mapCollapsed) {
      mapCollapsed = false;
      const mapSection = document.getElementById('map-section');
      mapSection.classList.remove('collapsed');
      if (preMax.mapHeight) mapSection.style.height = preMax.mapHeight;
      document.getElementById('map-toggle-btn').textContent = '\u25be Collapse';
      mapHeightBeforeCollapse = preMax.mapHeight || '50%';
    }

    isMaximized = false;
    button.classList.remove('maximized');
    icon.textContent = '\u2922';
    label.textContent = 'MAX';
    updateMainTerminalLayout();
    setTimeout(() => { map.invalidateSize(); }, 260);
  }

  return {
    isSidebarCollapsed: () => sidebarCollapsed,
    isMapCollapsed: () => mapCollapsed,
    isMaximized: () => isMaximized,
    getMapHeightBeforeCollapse: () => mapHeightBeforeCollapse,
    setMapHeightBeforeCollapse: (value) => {
      mapHeightBeforeCollapse = value;
    },
    toggleSidebarCollapse,
    toggleSidebar,
    refreshRailActive,
    toggleMap,
    toggleMaximize,
  };
}
