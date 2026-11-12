import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import anychart from 'anychart';
import App from './demo/App.jsx';

// AnyChart draws a trial watermark until it has a licence key. Put yours in a .env file (see .env.example).
if (import.meta.env.VITE_ANYCHART_LICENSE_KEY) anychart.licenseKey(import.meta.env.VITE_ANYCHART_LICENSE_KEY);

createRoot(document.getElementById('root')).render(<StrictMode><App /></StrictMode>);
