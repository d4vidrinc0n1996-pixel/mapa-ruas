// Seguimiento continuo de la posición del dispositivo.

const ERRORS = {
  1: 'Permiso de ubicación denegado. Actívalo en la configuración del navegador.',
  2: 'No se pudo obtener la ubicación. Revisa que el GPS esté encendido.',
  3: 'Buscando señal GPS… está tardando más de lo normal.',
};

export class GpsTracker {
  constructor({ onFix, onError }) {
    this.onFix = onFix;
    this.onError = onError;
    this.watchId = null;
    this.wakeLock = null;
  }

  get active() {
    return this.watchId !== null;
  }

  start() {
    if (this.active) return;
    if (!('geolocation' in navigator)) {
      this.onError(new Error('Este dispositivo no permite geolocalización.'));
      return;
    }
    if (!window.isSecureContext) {
      this.onError(new Error('El GPS requiere abrir la app por HTTPS.'));
      return;
    }
    this.watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const c = pos.coords;
        this.onFix({
          lat: c.latitude,
          lon: c.longitude,
          accuracy: c.accuracy,
          altitude: c.altitude,
          altitudeAccuracy: c.altitudeAccuracy,
          speed: c.speed,
          heading: Number.isFinite(c.heading) ? c.heading : null,
          timestamp: pos.timestamp,
        });
      },
      (err) => {
        if (err.code === 1) this.stop();
        this.onError(new Error(ERRORS[err.code] ?? err.message), err.code);
      },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 30000 },
    );
    this.keepScreenOn();
  }

  stop() {
    if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
    this.wakeLock?.release().catch(() => {});
    this.wakeLock = null;
  }

  // En campo la pantalla no debe apagarse mientras se sigue la posición.
  async keepScreenOn() {
    try {
      this.wakeLock = await navigator.wakeLock?.request('screen');
    } catch {
      /* no soportado o denegado */
    }
  }

  resume() {
    if (this.active && !this.wakeLock) this.keepScreenOn();
  }
}
