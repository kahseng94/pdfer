import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// Set before the first paint so the layout never jumps under the window buttons.
if (window.pdferDesktop?.titleBar === 'hidden') document.documentElement.dataset.titleBar = 'hidden'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
