'use strict';
/* Graphite Sider — shared provider/model picker for content scripts.
 * Loaded (manifest) before content/youtube.js and content/search.js, which
 * cannot load sidebar code. Builds two <select>s (provider, model) with DOM
 * APIs only, reads settings via the background (getSettings) and persists
 * picks via the background (setActiveModel -> GraphiteStorage.saveSettings)
 * so content scripts never write the whole settings blob themselves.
 * Attaches `GraphiteModelSelect` to globalThis. */
(function (global) {
  function runtimeApi() {
    if (typeof global.browser !== 'undefined' && global.browser && global.browser.runtime) return global.browser;
    if (typeof global.chrome !== 'undefined' && global.chrome && global.chrome.runtime) return global.chrome;
    return null;
  }

  function sendMessage(msg) {
    var api = runtimeApi();
    if (!api) return Promise.reject(new Error('runtime unavailable'));
    var raw;
    try { raw = api.runtime.sendMessage(msg); } catch (e) { return Promise.reject(e); }
    return Promise.resolve(raw).then(function (resp) {
      if (resp && typeof resp === 'object' && 'ok' in resp && ('result' in resp || 'error' in resp)) {
        if (resp.ok) return resp.result;
        throw new Error(resp.error || 'Background request failed');
      }
      return resp;
    });
  }

  /* Mirror of sidebar normalizeProviders: enabled providers only, model
   * lists deduped, the configured model first. */
  function normalizeProviders(settings) {
    var out = [];
    if (!settings) return out;
    var list = settings.providers || settings.providerConfigs || [];
    if (!Array.isArray(list) && typeof list === 'object') {
      list = Object.keys(list).map(function (k) { var v = list[k]; v.id = v.id || k; return v; });
    }
    (list || []).forEach(function (p) {
      if (!p) return;
      var rawModels = p.models || [];
      if (typeof rawModels === 'string') rawModels = [rawModels];
      if (!Array.isArray(rawModels)) rawModels = [];
      var models = [];
      rawModels.forEach(function (m) {
        var id = '';
        if (typeof m === 'string') id = m.trim();
        else if (m && typeof m === 'object') {
          var keys = ['id', 'name', 'model'];
          for (var i = 0; i < keys.length; i++) {
            var v = m[keys[i]];
            if (typeof v === 'string' && v.trim()) { id = v.trim(); break; }
          }
        }
        if (id && models.indexOf(id) === -1) models.push(id);
      });
      var configured = String(p.model || p.defaultModel || '').trim();
      if (configured) models = [configured].concat(models.filter(function (m) { return m !== configured; }));
      out.push({
        id: p.id || p.name || 'provider',
        label: p.label || p.name || p.id || 'Provider',
        model: configured || (models[0] || ''),
        models: models,
        enabled: p.enabled !== false
      });
    });
    return out.filter(function (p) { return p.enabled; });
  }

  function resolveSelection(settings, providers) {
    var list = providers || normalizeProviders(settings);
    var providerId = (settings && (settings.activeProviderId || settings.providerId || settings.provider)) || '';
    var found = list.filter(function (p) { return p.id === providerId; })[0] || list[0] || null;
    if (!found) return { providerId: '', model: '' };
    var model = (settings && settings.activeModel) || '';
    if (!model || found.models.indexOf(model) === -1) model = found.model || found.models[0] || '';
    return { providerId: found.id, model: model || '' };
  }

  /* createPicker(container, { onChange }) -> { el, getSelection, refresh }
   * onChange({providerId, model}) fires after a persisted user pick. */
  function createPicker(container, opts) {
    opts = opts || {};
    var doc = container.ownerDocument || global.document;
    var wrap = doc.createElement('span');
    wrap.className = 'gs-model-picker';
    var providerSel = doc.createElement('select');
    providerSel.className = 'gs-model-provider';
    providerSel.setAttribute('aria-label', 'Provider');
    providerSel.title = 'Provider';
    var modelSel = doc.createElement('select');
    modelSel.className = 'gs-model-model';
    modelSel.setAttribute('aria-label', 'Model');
    modelSel.title = 'Model';
    wrap.appendChild(providerSel);
    wrap.appendChild(modelSel);
    container.appendChild(wrap);

    var providers = [];
    var selection = { providerId: '', model: '' };

    function fill(select, values, current, emptyLabel) {
      select.replaceChildren();
      if (!values.length) {
        var o = doc.createElement('option');
        o.value = '';
        o.textContent = emptyLabel;
        select.appendChild(o);
        select.value = '';
        return;
      }
      values.forEach(function (v) {
        var o = doc.createElement('option');
        o.value = v.value;
        o.textContent = v.label;
        select.appendChild(o);
      });
      select.value = current;
    }
    function render() {
      fill(providerSel, providers.map(function (p) { return { value: p.id, label: p.label }; }),
        selection.providerId, 'No provider');
      var p = providers.filter(function (x) { return x.id === selection.providerId; })[0];
      var models = p ? p.models : [];
      fill(modelSel, models.map(function (m) { return { value: m, label: m }; }),
        selection.model, 'Default model');
      providerSel.disabled = !providers.length;
      modelSel.disabled = !models.length;
    }
    function persist() {
      sendMessage({ type: 'setActiveModel', providerId: selection.providerId, model: selection.model })
        .catch(function () { /* background/options will reconcile on next load */ });
      if (typeof opts.onChange === 'function') {
        try { opts.onChange({ providerId: selection.providerId, model: selection.model }); } catch (e) {}
      }
    }
    providerSel.addEventListener('change', function () {
      selection.providerId = providerSel.value;
      var p = providers.filter(function (x) { return x.id === selection.providerId; })[0];
      selection.model = p ? (p.model || p.models[0] || '') : '';
      render();
      persist();
    });
    modelSel.addEventListener('change', function () {
      selection.model = modelSel.value;
      persist();
    });
    function refresh() {
      return sendMessage({ type: 'getSettings' }).then(function (settings) {
        providers = normalizeProviders(settings || {});
        selection = resolveSelection(settings || {}, providers);
        render();
        return { providerId: selection.providerId, model: selection.model };
      }).catch(function () {
        providers = [];
        selection = { providerId: '', model: '' };
        render();
        return { providerId: '', model: '' };
      });
    }
    render();
    refresh();
    return {
      el: wrap,
      getSelection: function () { return { providerId: selection.providerId, model: selection.model }; },
      refresh: refresh
    };
  }

  global.GraphiteModelSelect = {
    normalizeProviders: normalizeProviders,
    resolveSelection: resolveSelection,
    createPicker: createPicker
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
