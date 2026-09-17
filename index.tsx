
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { appFeatures } from './config/appConfig';
import './styles.css';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
// A compile-time boundary: gallery code, styling and local-record requests are
// removed from public builds, even when someone visits /gallery directly.
if (import.meta.env.DEV && appFeatures.demoRecords && window.location.pathname.replace(/\/$/, '') === '/gallery') {
  void import('./gallery/GalleryApp').then(({ default: GalleryApp }) => {
    root.render(<React.StrictMode><GalleryApp /></React.StrictMode>);
  });
} else {
  root.render(<React.StrictMode><App /></React.StrictMode>);
}
