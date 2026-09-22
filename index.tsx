
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
// The gallery shares its presentation; each build reads its own local records.
if (appFeatures.gallery && window.location.pathname.replace(/\/$/, '') === '/gallery') {
  void import('./gallery/GalleryApp').then(({ default: GalleryApp }) => {
    root.render(<React.StrictMode><GalleryApp /></React.StrictMode>);
  });
} else {
  root.render(<React.StrictMode><App /></React.StrictMode>);
}
