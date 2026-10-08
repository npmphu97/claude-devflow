// tutoring-hub rules that need more than one regex (copy to scripts/devflow-rules.mjs, referenced by
// "rulesModule" in .devflow.json). Called by scripts/devflow/hard-rules.mjs with the changed lines.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export default function rules({ files, add, root, isCode, readFile }) {
  const migrationsAdded = [...files.keys()].some(f => f.startsWith('docker/mysql/migrations/'));
  let schemaWarned = false;

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
