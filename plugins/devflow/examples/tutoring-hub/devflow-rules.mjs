// tutoring-hub rules that need more than one regex (copy to scripts/devflow-rules.mjs, referenced by
// "rulesModule" in .devflow.json). Called by scripts/devflow/hard-rules.mjs with the changed lines.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export default function rules({ files, add, root, isCode, readFile }) {
  const migrationsAdded = [...files.keys()].some(f => f.startsWith('docker/mysql/migrations/'));
  let schemaWarned = false;

  for (const [f, { added }] of files) {
    // Rule 6 (CODE_QUALITY): CSS uses tokens from frontend/src/styles/_tokens.scss. WARN only.
    // .ts lines are checked only when they look like a CSS declaration (component inline styles).
    const isCss = f.startsWith('frontend/src/') && ((/\.s?css$/.test(f) && !f.endsWith('/_tokens.scss')) || f.endsWith('.ts'));
    if (!isCss) continue;
    for (const l of added) {
      if (!isCode(l.text)) continue;
      for (const m of l.text.matchAll(/(?:^|[{;\s])([a-z-]+)\s*:\s*([^;{}]*)/g)) {
        const [, prop, value] = m;
        if (prop.startsWith('--')) continue;
        if (/^(color|background(-color)?|border(-[a-z]+)*|outline(-color)?|box-shadow|text-shadow|fill|stroke|accent-color|caret-color|scrollbar-color)$/.test(prop)
          && /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|(?<![\w-])(white|black)(?![\w-])/i.test(value)) {
          add('WARN', f, l.n, `màu viết cứng trong \`${prop}\` — dùng token var(--…) (CODE_QUALITY: CSS dùng token)`);
        } else if (prop === 'z-index' && /^\s*\d{2,}/.test(value)) {
          add('WARN', f, l.n, `z-index ${value.trim()} viết cứng — dùng thang --z-* (CODE_QUALITY: CSS dùng token)`);
        } else if (/^(border(-[a-z]+)*-radius|font-size)$/.test(prop) && /(?<![\w.-])\d*\.?\d+(px|rem|em)\b/.test(value)) {
          add('WARN', f, l.n, `\`${prop}: ${value.trim()}\` ngoài thang — dùng ${prop === 'font-size' ? '--fs-*' : '--radius-*'} (CODE_QUALITY: CSS dùng token)`);
        }
      }
    }
  }

  for (const [f, { added, removed, isNew }] of files) {
    if (!(f.startsWith('backend/src/main/') && f.endsWith('.java'))) continue;
    const code = added.filter(l => isCode(l.text));

    // Rule 1: column changes that ddl-auto=update will not apply need a migration script.
    if (/\/domain\/(model|entity)\//.test(f) && !isNew && !schemaWarned && !migrationsAdded) {
      const colChange = [...added, ...removed].find(l => /@Column\(.*\b(length|nullable|unique|name|columnDefinition)\s*=/.test(l.text) || /@Table\(.*uniqueConstraints/.test(l.text));
      const removedField = removed.find(l => /^\s*private\s+[\w<>, ]+\s+\w+\s*(=.*)?;/.test(l.text));
      if (colChange || removedField) {
        add('WARN', f, (colChange ?? removedField).n, 'entity đổi/xoá cột — nếu cột cũ đã có trong DB thì cần script docker/mysql/migrations/YYYY-MM-DD_<tên>.sql (luật 1)');
        schemaWarned = true;
      }
    }

    // Rule 2: services that write must be @Transactional.
    if (/\/application\/[^/]+Service\.java$/.test(f) && existsSync(join(root, f))) {
      const writes = code.find(l => /\b\w*(Repo|Repository)\w*\.(save|saveAll|delete\w*)\(/.test(l.text));
      if (writes && !/@Transactional/.test(readFile(f))) {
        add('WARN', f, writes.n, 'service ghi DB nhưng file không có @Transactional nào (luật 2)');
      }
    }
  }
}
