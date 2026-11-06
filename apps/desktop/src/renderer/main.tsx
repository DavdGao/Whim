import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { publishSharedModules } from './plugins/shared-modules';
import './index.css';

// Plugin client entries resolve React and the UI components to the host's copies.
publishSharedModules();

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element.');
createRoot(root).render(
    <StrictMode>
        <App />
    </StrictMode>
);
