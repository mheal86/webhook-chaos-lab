import type { AssertionResult } from '@lab/shared/web';
import { useApiText, useLang } from '../i18n';
import { StatusBadge } from './ui';

/** Expected (from the scenario) vs actual (from the database) with pending/passed/failed status. */
export function AssertionsTable({ assertions }: { assertions: AssertionResult[] }) {
  const { t } = useLang();
  const apiText = useApiText();
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm" data-testid="assertions">
        <caption className="sr-only">
          {t('Expected versus actual results', 'Kỳ vọng so với thực tế')}
        </caption>
        <thead className="text-xs uppercase tracking-wider text-muted">
          <tr>
            <th className="py-2 pr-4 font-medium">{t('Check', 'Kiểm tra')}</th>
            <th className="py-2 pr-4 font-medium">{t('Expected', 'Kỳ vọng')}</th>
            <th className="py-2 pr-4 font-medium">{t('Actual', 'Thực tế')}</th>
            <th className="py-2 font-medium">{t('Status', 'Trạng thái')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {assertions.map((a) => (
            <tr key={a.key} data-testid={`assertion-${a.key}`}>
              <td className="py-2 pr-4">{apiText(a.label)}</td>
              <td className="py-2 pr-4 font-mono tabular-nums">{String(a.expectedValue ?? '—')}</td>
              <td className="py-2 pr-4 font-mono tabular-nums">{String(a.actual ?? '—')}</td>
              <td className="py-2">
                <StatusBadge value={a.status} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
