import { parentPort, workerData } from 'node:worker_threads';

import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { z } from 'zod';

const bytes = z.instanceof(Uint8Array).parse(workerData);
const task = getDocument({
    data: bytes,
    useSystemFonts: false,
    disableFontFace: true,
    verbosity: 0,
});
try {
    const pdf = await task.promise;
    if (pdf.numPages > 10) throw new Error('PDF page limit exceeded.');
    const pages: string[] = [];
    let size = 0;
    for (let index = 1; index <= pdf.numPages; index++) {
        const page = await pdf.getPage(index);
        const content = await page.getTextContent();
        const text = content.items.map(item => ('str' in item ? item.str : '')).join(' ');
        if (!text.trim()) throw new Error('PDF contains a page requiring OCR.');
        size += new TextEncoder().encode(text).length;
        if (size > 100000) throw new Error('PDF extracted text limit exceeded.');
        pages.push(`[Page ${index}]\n${text}`);
        page.cleanup();
    }
    parentPort?.postMessage({ text: pages.join('\n\n') });
} catch {
    parentPort?.postMessage({ error: true });
} finally {
    await task.destroy();
    parentPort?.close();
}
