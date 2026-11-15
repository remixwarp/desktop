/**
 * Android 离线版兼容层。
 *
 * 桌面版编辑器页面在 Electron 里由 preload 脚本注入 window.EditorPreload，
 * 并用 tw-editor:// / tw-privacy:// / tw-about:// / tw-packager:// 这些自定义协议
 * 打开子页面。WebView 里没有这些能力，所以这里用浏览器 API 兜底：
 *  - 项目打开：<input type="file">
 *  - 项目保存：累积写入的数据，完成后交给 AndroidBridge 写进“下载”目录
 *  - 设置 / 关于 / 隐私 / 打包器：把自定义协议映射成 www 里的静态路径
 *
 * 这个文件由 scripts/build-android-web.mjs 在构建时插入 gui.html（先于 index.js）。
 */
(function () {
  if (window.EditorPreload) {
    return;
  }

  var bridge = window.AndroidBridge || null;
  var SETTINGS_KEY = 'rw:android:desktop-settings';
  var DEFAULT_SETTINGS = {
    updateChecker: 'never',
    updateCheckerAllowed: false,
    microphone: '',
    camera: '',
    hardwareAcceleration: true,
    backgroundThrottling: true,
    bypassCORS: false
  };

  var readSettings = function () {
    try {
      var stored = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) || '{}');
      var result = {};
      Object.keys(DEFAULT_SETTINGS).forEach(function (key) {
        result[key] = Object.prototype.hasOwnProperty.call(stored, key)
          ? stored[key]
          : DEFAULT_SETTINGS[key];
      });
      return result;
    } catch (error) {
      return Object.assign({}, DEFAULT_SETTINGS);
    }
  };

  var loadJSON = function (url) {
    try {
      var request = new XMLHttpRequest();
      request.open('GET', url, false);
      request.send(null);
      if (request.status >= 200 && request.status < 300) {
        return JSON.parse(request.responseText);
      }
    } catch (error) {
      // 忽略：缺少翻译文件时回退到 message id
    }
    return null;
  };

  var en = loadJSON(new URL('../../l10n/en.json', window.location.href).href) || {};
  var otherTranslations =
    loadJSON(new URL('../../l10n/generated-translations.json', window.location.href).href) || {};

  var englishStrings = {};
  Object.keys(en).forEach(function (id) {
    englishStrings[id] = en[id].string;
  });

  var stringsFor = function (locale) {
    var result = Object.assign({}, englishStrings);
    var candidates = [locale];
    if (locale && locale.indexOf('-') !== -1) {
      candidates.push(locale.split('-')[0]);
    }
    for (var i = 0; i < candidates.length; i++) {
      var translation = otherTranslations[candidates[i]];
      if (translation) {
        Object.assign(result, translation);
        break;
      }
    }
    return result;
  };

  // ---------------------------------------------------------------------------
  // 文件：打开
  // ---------------------------------------------------------------------------
  var files = {};
  var nextFileId = 0;

  var pickFile = function () {
    return new Promise(function (resolve) {
      var input = document.createElement('input');
      input.type = 'file';
      input.accept = '.sb3,.sb2,.sb,.rj,.json,application/octet-stream';
      input.style.display = 'none';
      document.body.appendChild(input);

      var finish = function (value) {
        if (input.parentNode) {
          input.parentNode.removeChild(input);
        }
        resolve(value);
      };

      input.addEventListener('change', function () {
        var file = input.files && input.files[0];
        if (!file) {
          return finish(null);
        }
        var reader = new FileReader();
        reader.onload = function () {
          var id = 'android-file-' + nextFileId++;
          files[id] = {
            name: file.name,
            data: new Uint8Array(reader.result)
          };
          finish({id: id, name: file.name});
        };
        reader.onerror = function () {
          finish(null);
        };
        reader.readAsArrayBuffer(file);
      });

      input.addEventListener('cancel', function () {
        finish(null);
      });

      input.click();
    });
  };

  // ---------------------------------------------------------------------------
  // 文件：保存（WrappedFileWritable 通过 window.postMessage + MessageChannel 写入）
  // ---------------------------------------------------------------------------
  var pendingSaves = {};
  var nextSaveId = 0;

  var bytesToBase64 = function (bytes) {
    var chunkSize = 0x8000;
    var binary = '';
    for (var i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(
        null,
        bytes.subarray(i, Math.min(i + chunkSize, bytes.length))
      );
    }
    return window.btoa(binary);
  };

  var concatenate = function (chunks) {
    var total = 0;
    chunks.forEach(function (chunk) {
      total += chunk.length;
    });
    var result = new Uint8Array(total);
    var offset = 0;
    chunks.forEach(function (chunk) {
      result.set(chunk, offset);
      offset += chunk.length;
    });
    return result;
  };

  var guessMime = function (name) {
    if (/\.json$/i.test(name)) return 'application/json';
    if (/\.zip$|\.sb3$|\.sb2$|\.rj$/i.test(name)) return 'application/zip';
    return 'application/octet-stream';
  };

  var saveChunksToDisk = function (name, chunks) {
    var bytes = concatenate(chunks);
    if (bridge && typeof bridge.saveFile === 'function') {
      bridge.saveFile(name, guessMime(name), bytesToBase64(bytes));
      return;
    }
    var blob = new Blob([bytes], {type: guessMime(name)});
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 10000);
  };

  window.addEventListener('message', function (event) {
    if (event.source !== window) {
      return;
    }
    var data = event.data;
    if (!data || typeof data.ipcStartWriteStream !== 'string') {
      return;
    }
    var save = pendingSaves[data.ipcStartWriteStream];
    var port = event.ports && event.ports[0];
    if (!save || !port) {
      return;
    }
    port.onmessage = function (messageEvent) {
      var message = messageEvent.data || {};
      if (message.write) {
        save.chunks.push(new Uint8Array(message.write));
        if (message.id !== undefined) {
          port.postMessage({response: {id: message.id, result: true}});
        }
      } else if (message.finish) {
        try {
          saveChunksToDisk(save.name, save.chunks);
          port.postMessage({response: {id: message.id, result: true}});
        } catch (error) {
          port.postMessage({error: String(error)});
        }
        delete pendingSaves[save.id];
      } else if (message.abort) {
        delete pendingSaves[save.id];
        port.postMessage({response: {id: message.id, result: true}});
      }
    };
  });

  var savePicker = function (suggestedName) {
    return new Promise(function (resolve) {
      var name = window.prompt('保存为', suggestedName || 'project.sb3');
      if (!name) {
        return resolve(null);
      }
      var id = 'android-save-' + nextSaveId++;
      pendingSaves[id] = {id: id, name: name, chunks: []};
      resolve({id: id, name: name});
    });
  };

  // ---------------------------------------------------------------------------
  // 自定义协议 -> 本地静态文件
  // ---------------------------------------------------------------------------
  var SCHEME_TARGETS = {
    'tw-editor': '../../editor/',
    'tw-privacy': '../../privacy/',
    'tw-about': '../../about/',
    'tw-packager': '../../packager/'
  };

  var rewriteURL = function (url) {
    if (typeof url !== 'string') {
      return url;
    }
    var split = url.indexOf('://');
    if (split === -1) {
      return url;
    }
    var scheme = url.substring(0, split);
    var target = SCHEME_TARGETS[scheme];
    if (!target) {
      return url;
    }
    var rest = url.substring(split + 3).replace(/^\.?\//, '');
    return new URL(target + rest, window.location.href).href;
  };

  var originalOpen = window.open;
  window.open = function (url) {
    var args = Array.prototype.slice.call(arguments);
    args[0] = rewriteURL(url);
    return originalOpen.apply(window, args);
  };

  var openInternal = function (url) {
    window.open(rewriteURL(url));
  };

  // ---------------------------------------------------------------------------
  // EditorPreload
  // ---------------------------------------------------------------------------
  var exportForPackager = function () {
    return Promise.reject(new Error('exportForPackager missing'));
  };

  window.EditorPreload = {
    isInitiallyFullscreen: function () {
      return false;
    },

    getInitialFile: function () {
      return Promise.resolve(null);
    },

    getFile: function (id) {
      var file = files[id];
      if (!file) {
        return Promise.reject(new Error('Unknown file: ' + id));
      }
      return Promise.resolve({
        name: file.name,
        type: 'file',
        data: file.data
      });
    },

    openedFile: function () {},
    closedFile: function () {},
    setChanged: function () {},

    showOpenFilePicker: pickFile,
    showSaveFilePicker: savePicker,

    setLocale: function (locale) {
      document.documentElement.lang = locale;
      return {
        strings: stringsFor(locale)
      };
    },

    getDesktopSettings: readSettings,

    setDesktopSetting: function (key, value) {
      var settings = readSettings();
      settings[key] = value;
      try {
        window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
      } catch (error) {
        // 忽略存储失败
      }
      return Promise.resolve();
    },

    openUserData: function () {
      if (bridge) {
        bridge.toast('Android 版没有用户数据目录，项目会保存到“下载”');
      }
    },

    openNewWindow: function () {
      // 移动端只有单窗口，忽略
    },

    openPackager: function () {
      openInternal('tw-packager://./packager.html');
    },

    getAboutInfo: function () {
      return {
        appName: 'RemixWarp',
        version: (window.__RW_ANDROID__ && window.__RW_ANDROID__.version) || '0.0.0',
        dist: 'android',
        electron: '',
        platform: 'android',
        arch: 'arm64'
      };
    },

    exportAddonSettings: function (settings) {
      var name = 'remixwarp-addon-settings.json';
      var blob = new Blob([settings], {type: 'application/json'});
      if (bridge) {
        var reader = new FileReader();
        reader.onload = function () {
          bridge.saveFile(name, 'application/json', bytesToBase64(new Uint8Array(reader.result)));
        };
        reader.readAsArrayBuffer(blob);
        return;
      }
      var url = URL.createObjectURL(blob);
      var link = document.createElement('a');
      link.href = url;
      link.download = name;
      link.click();
      setTimeout(function () {
        URL.revokeObjectURL(url);
      }, 10000);
    },

    getPreferredMediaDevices: function () {
      return {
        microphone: '',
        camera: ''
      };
    },

    getAdvancedCustomizations: function () {
      return Promise.resolve({
        userscript: '',
        userstyle: ''
      });
    },

    setExportForPackager: function (callback) {
      if (typeof callback === 'function') {
        exportForPackager = callback;
      }
    },

    setIsFullScreen: function (isFullScreen) {
      if (bridge) {
        bridge.setFullScreen(!!isFullScreen);
      }
    }
  };
})();
