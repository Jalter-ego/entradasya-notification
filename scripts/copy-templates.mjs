import { cp, mkdir } from 'node:fs/promises';

const source = new URL('../src/email/templates/', import.meta.url);
const destination = new URL('../dist/email/templates/', import.meta.url);
await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true });
