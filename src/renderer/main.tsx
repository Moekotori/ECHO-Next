import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource/outfit/400.css';
import '@fontsource/outfit/500.css';
import '@fontsource/outfit/600.css';
import '@fontsource/outfit/700.css';
import '@fontsource/outfit/800.css';
import '@fontsource/outfit/900.css';
import { App } from './app/App';
import { applyAppearancePreferences, readAppearancePreferences, registerAppearanceFontFile } from './preferences/appearancePreferences';
import { getAppBridge } from './utils/echoBridge';
import './styles/tokens.css';
import './styles/theme.css';
import './styles/layout.css';
import './styles/app.css';
import './styles/songs.css';
import './styles/eq.css';
import './styles/album-detail.css';
import './styles/artist-detail.css';
import './styles/queue.css';

const appearancePreferences = readAppearancePreferences();
const appBridge = getAppBridge();
applyAppearancePreferences(appearancePreferences);

if (appearancePreferences.mainFontFilePath && appBridge) {
  void appBridge.loadFontFile(appearancePreferences.mainFontFilePath).then((fontFile) => registerAppearanceFontFile('main', fontFile)).catch(() => undefined);
}

if (appearancePreferences.chineseFontFilePath && appBridge) {
  void appBridge
    .loadFontFile(appearancePreferences.chineseFontFilePath)
    .then((fontFile) => registerAppearanceFontFile('chinese', fontFile))
    .catch(() => undefined);
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
