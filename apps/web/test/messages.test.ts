/** AC-22.1: no missing translation and no hard-coded visible text, checked against the source. */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'vitest';

const root = join(import.meta.dirname, '..');
const messages = JSON.parse(readFileSync(join(root, 'messages/en.json'), 'utf8')) as Record<string, unknown>;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}
const files = sources(join(root, 'src')).map((path) => ({ name: relative(root, path), text: readFileSync(path, 'utf8') }));

function lookup(path: string): unknown {
  return path.split('.').reduce<unknown>((node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined), messages);
}

describe('messages', () => {
  test('every key used in the code exists', () => {
    const missing: string[] = [];
    for (const { name, text } of files) {
      const declarations = [...text.matchAll(/const (\w+) = useTranslations\((?:'([\w.]+)')?\)/g)];
      declarations.forEach((declaration, index) => {
        const [, variable, namespace] = declaration;
        const next = declarations.slice(index + 1).find((other) => other[1] === variable);
        const scope = text.slice(declaration.index, next?.index ?? text.length);
        const prefix = namespace ? `${namespace}.` : '';
        for (const use of scope.matchAll(new RegExp(`\\b${variable}(?:\\.rich|\\.raw)?\\(\\s*'([^']+)'`, 'g'))) {
          if (lookup(prefix + use[1]) === undefined) missing.push(`${name}: ${prefix}${use[1]}`);
        }
        // A computed key: at least the part before the variable must exist.
        for (const use of scope.matchAll(new RegExp(`\\b${variable}(?:\\.rich|\\.raw)?\\(\\s*\`([\\w.]+)\\.\\$\\{`, 'g'))) {
          if (typeof lookup(prefix + use[1]) !== 'object') missing.push(`${name}: ${prefix}${use[1]}.*`);
        }
      });
    }
    expect(missing).toEqual([]);
  });

  test('every error code the screens translate has a text', () => {
    const api = files.find((file) => file.name.replaceAll('\\', '/') === 'src/lib/api.ts')!.text;
    const codes = [...api.match(/TRANSLATED_CODES = new Set\(\[([\s\S]*?)\]\)/)![1]!.matchAll(/'(\w+)'/g)].map((match) => match[1]!);
    expect(codes.length).toBeGreaterThan(5);
    expect(codes.filter((code) => lookup(`errors.${code}`) === undefined)).toEqual([]);
  });

  test('no visible text is written directly in a screen', () => {
    const found: string[] = [];
    for (const { name, text } of files) {
      if (!name.endsWith('.tsx')) continue;
      for (const match of text.matchAll(/>\s*([A-Za-z][a-z]+(?: [^<>{}]+)?)\s*<\//g)) found.push(`${name}: ${match[1]}`);
      for (const match of text.matchAll(/\b(?:aria-label|title|placeholder|alt)="([^"]*[A-Za-z][^"]*)"/g)) found.push(`${name}: ${match[1]}`);
    }
    expect(found).toEqual([]);
  });
});
