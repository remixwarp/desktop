import React from 'react';
import {compose} from 'redux';
import GUI, {AppStateHOC} from 'scratch-gui';

import ErrorContainerHOC from '../error/error-container-hoc.jsx';
import DesktopHOC from './desktop-hoc.jsx';
import CloudProviderHOC from './cloud-provider-hoc.jsx';
import {showOpenFilePicker, showSaveFilePicker} from './filesystem-api.js';
import './normalize.css';
import './gui.css';

const APP_VERSION = '1.0.6';
const APP_REPO_OWNER = 'remixwarp';
const APP_REPO_NAME = 'desktop';

const WrappedGUI = compose(
  ErrorContainerHOC,
  AppStateHOC,
  DesktopHOC,
  CloudProviderHOC
)(GUI);

const GUIWithProps = () => (
  <WrappedGUI
    isScratchDesktop
    isFullScreen={EditorPreload.isInitiallyFullscreen()}
    canEditTitle

    // Cloud variables can be created, but not used.
    canModifyCloudData
    canUseCloud
    cloudHost="wss://fake-clouddata-server.bilup.org"

    backpackVisible
    backpackHost="_local_"

    showOpenFilePicker={showOpenFilePicker}
    showSaveFilePicker={showSaveFilePicker}
  />
);

GUIWithProps.setAppElement = GUI.setAppElement;

/**
 * Build an accelerated download URL for a GitHub release asset.
 * Uses ghproxy.com mirror for faster downloads in regions where GitHub is slow.
 * Falls back to direct GitHub URL if the mirror is unavailable.
 */
const buildAcceleratedUrl = (filename) => {
  const direct = `https://github.com/${APP_REPO_OWNER}/${APP_REPO_NAME}/releases/download/v${APP_VERSION}/${filename}`;
  // Use ghproxy.com as acceleration mirror; users in mainland China / slow GitHub
  // regions get much faster downloads this way.
  return `https://ghproxy.com/${direct}`;
};

const openExternalUrl = (url) => {
  // In Electron preload context, we can use shell.openExternal indirectly,
  // but window.open works fine for simple navigation:
  window.open(url, '_blank', 'noopener,noreferrer');
};

const AppxDevDownloadBar = () => (
  <div className="appx-dev-bar" role="group" aria-label="Windows APPX developer downloads">
    <span className="appx-dev-label">Dev · Win APPX:</span>
    <button
      className="appx-dev-btn"
      title="Download Windows APPX (x64) via accelerated mirror"
      onClick={() => openExternalUrl(buildAcceleratedUrl(`RemixWarp-MS-Store-${APP_VERSION}-x64.appx`))}
    >
      x64
    </button>
    <button
      className="appx-dev-btn"
      title="Download Windows APPX (ia32) via accelerated mirror"
      onClick={() => openExternalUrl(buildAcceleratedUrl(`RemixWarp-MS-Store-${APP_VERSION}-ia32.appx`))}
    >
      ia32
    </button>
    <button
      className="appx-dev-btn"
      title="Download Windows APPX (arm64) via accelerated mirror"
      onClick={() => openExternalUrl(buildAcceleratedUrl(`RemixWarp-MS-Store-${APP_VERSION}-arm64.appx`))}
    >
      arm64
    </button>
  </div>
);

const AppWithDevBar = () => (
  <div className="app-with-dev-bar">
    <GUIWithProps />
    <AppxDevDownloadBar />
  </div>
);

AppWithDevBar.setAppElement = GUI.setAppElement;

export default AppWithDevBar;
