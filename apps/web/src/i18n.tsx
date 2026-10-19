import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

/**
 * Two-language UI (English default, Vietnamese). Strings stay next to the markup that uses them:
 * `t('English', 'Tiếng Việt')`. The choice is remembered per browser.
 */
export type Lang = 'en' | 'vi';

interface LangState {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: <T>(en: T, vi: T) => T;
}

const STORAGE_KEY = 'chaos-lab.lang';

function readStored(): Lang {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'vi' ? 'vi' : 'en';
  } catch {
    return 'en';
  }
}

const LangContext = createContext<LangState>({
  lang: 'en',
  setLang: () => undefined,
  t: (en) => en,
});

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(readStored);
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  const value = useMemo<LangState>(
    () => ({
      lang,
      setLang: (l) => {
        setLangState(l);
        try {
          localStorage.setItem(STORAGE_KEY, l);
        } catch {
          /* storage unavailable: the choice is just not remembered */
        }
      },
      t: (en, vi) => (lang === 'vi' ? vi : en),
    }),
    [lang],
  );
  return <LangContext.Provider value={value}>{children}</LangContext.Provider>;
}

export const useLang = () => useContext(LangContext);

/** Text that comes from the API in English (assertion labels), translated when known. */
const API_TEXT_VI: Record<string, string> = {
  'Every delivery reached a terminal state': 'Mọi delivery đều đã kết thúc',
  'Business effects equal succeeded deliveries': 'Số effect bằng số delivery thành công',
  'Events created': 'Số event đã tạo',
  'Deliveries succeeded': 'Delivery thành công',
  'Deliveries dead': 'Delivery bị bỏ (dead)',
  'HTTP attempts': 'Số lần gọi HTTP',
  'Business effects': 'Business effect (thay đổi thật)',
  'Receiver duplicates': 'Receiver báo trùng',
  'HTTP attempts (3 per delivery)': 'Số lần gọi HTTP (3 lần mỗi delivery)',
  'Max attempts on one delivery': 'Số lần thử nhiều nhất của 1 delivery',
  'Receiver injected 500s': 'Số lỗi 500 receiver cố tình trả',
  'Deliveries for the single event': 'Số delivery của cùng một event',
  'Requests received': 'Số request receiver nhận',
  'HTTP attempts (2 per delivery)': 'Số lần gọi HTTP (2 lần mỗi delivery)',
  'Attempts that timed out (outcome unknown at sender)':
    'Lần thử bị timeout (sender không biết kết quả)',
  'Receiver duplicates (retry after commit)': 'Receiver báo trùng (retry sau khi đã commit)',
  'Receive order (event sequence)': 'Thứ tự nhận (theo sequence)',
  'Order projection sequence': 'Sequence hiện tại của đơn hàng',
  'Snapshots applied': 'Snapshot được áp dụng',
  'Stale snapshots ignored': 'Snapshot cũ bị bỏ qua',
  'Original deliveries dead (history kept)': 'Delivery gốc dead (giữ nguyên lịch sử)',
  'Replay deliveries succeeded': 'Delivery replay thành công',
  'Dead deliveries with a replay child': 'Delivery dead đã có bản replay',
  'HTTP attempts (budget + 1 replay each)': 'Số lần gọi HTTP (hết lượt + 1 lần replay)',
  'Dead with permanent_failure': 'Dead do lỗi vĩnh viễn (permanent_failure)',
  'HTTP attempts (no retry)': 'Số lần gọi HTTP (không retry)',
  'Receiver rejected signature': 'Receiver từ chối chữ ký',
  'Receiver processed': 'Receiver đã xử lý',
};

export function useApiText() {
  const { lang } = useLang();
  return (en: string) => (lang === 'vi' ? (API_TEXT_VI[en] ?? en) : en);
}
