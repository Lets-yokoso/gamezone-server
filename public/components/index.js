const Components = {
  loaded: {},
  loading: {},
  loadOrder: ['Groups', 'Dashboard', 'PcControl'],

  async load(name) {
    if (this.loaded[name]) return true;
    if (this.loading[name]) {
      return new Promise(resolve => {
        const check = setInterval(() => {
          if (this.loaded[name]) { clearInterval(check); resolve(true); }
        }, 100);
      });
    }
    this.loading[name] = true;
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = '/components/' + name + '.js';
      script.onload = () => {
        this.loaded[name] = true;
        delete this.loading[name];
        resolve(true);
      };
      script.onerror = () => {
        delete this.loading[name];
        reject(new Error('Failed to load: ' + name));
      };
      document.head.appendChild(script);
    });
  },

  async prefetch() {
    for (const name of this.loadOrder) {
      if (!this.loaded[name] && !this.loading[name]) {
        const script = document.createElement('script');
        script.src = '/components/' + name + '.js';
        script.rel = 'prefetch';
        document.head.appendChild(script);
      }
    }
  },

  isLoaded(name) {
    return !!this.loaded[name];
  }
};

window.Components = Components;