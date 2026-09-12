import React from 'react';
import { createRoot } from 'react-dom/client';
import ExhibitionApp from './ui/App';
import './ui/style.css';
createRoot(document.getElementById('root')!).render(<React.StrictMode><ExhibitionApp /></React.StrictMode>);
