// Renderer entry point.

import { createRoot } from 'react-dom/client';
import { App, appActions } from './App';
import { runSelfTest, type SelfTestJob } from './selftest';

createRoot(document.getElementById('root')!).render(<App />);

window.recorder.onSelfTest((job) => void runSelfTest(JSON.parse(job) as SelfTestJob, (o) => appActions.open!(o)));
