import { Link } from 'react-router-dom';
import { PipelineDiagram, SCENARIO_KEYS, useStories } from '../components/explain';
import { PageTitle, Panel } from '../components/ui';
import { useLang } from '../i18n';

type Pair = [string, string];

const TERMS: Array<{ term: string; def: Pair }> = [
  {
    term: 'Webhook',
    def: [
      'An HTTP POST one system sends to another to say “this happened”.',
      'Một HTTP POST mà hệ thống này gửi sang hệ thống khác để báo “chuyện này vừa xảy ra”.',
    ],
  },
  {
    term: 'Event',
    def: [
      'The business fact, e.g. “order 1001 was paid”. Written once, never changed.',
      'Sự kiện nghiệp vụ, ví dụ “đơn 1001 đã thanh toán”. Ghi một lần, không bao giờ sửa.',
    ],
  },
  {
    term: 'Delivery',
    def: [
      'One plan to send an event to a receiver. Duplicates and replays are extra deliveries of the same event.',
      'Một lần “định gửi” event tới receiver. Bản trùng và bản gửi lại là các delivery khác của cùng một event.',
    ],
  },
  {
    term: 'Attempt',
    def: [
      'One real HTTP call of a delivery. A delivery may need several attempts.',
      'Một lần gọi HTTP thật của một delivery. Một delivery có thể cần nhiều lần thử.',
    ],
  },
  {
    term: 'Business effect',
    def: [
      'The change the receiver actually applies (e.g. +1 on a counter). Must happen exactly once per event.',
      'Thay đổi mà receiver thật sự áp dụng (ví dụ +1 vào bộ đếm). Mỗi event chỉ được xảy ra đúng một lần.',
    ],
  },
  {
    term: 'Retry + backoff',
    def: [
      'After a 5xx, timeout or network error the worker waits longer each time (with random jitter) and tries again.',
      'Sau lỗi 5xx, timeout hay lỗi mạng, worker chờ lâu dần sau mỗi lần (có thêm độ ngẫu nhiên jitter) rồi thử lại.',
    ],
  },
  {
    term: 'Dead letter',
    def: [
      'A delivery the system gave up on. It keeps its full attempt history and can be replayed by hand.',
      'Delivery mà hệ thống đã bỏ cuộc. Nó giữ đủ lịch sử các lần thử và có thể được gửi lại thủ công.',
    ],
  },
  {
    term: 'Idempotency',
    def: [
      'The receiver remembers event ids in the same database transaction as the effect, so a repeat is answered “duplicate” and changes nothing.',
      'Receiver ghi nhớ id của event trong cùng transaction với effect, nên request lặp lại sẽ được trả lời “trùng” và không thay đổi gì.',
    ],
  },
  {
    term: 'Outcome unknown',
    def: [
      'After a timeout the sender cannot know whether the receiver applied the event. It retries and relies on idempotency.',
      'Sau timeout, sender không thể biết receiver đã áp dụng event chưa. Nó thử lại và dựa vào idempotency.',
    ],
  },
  {
    term: 'HMAC signature',
    def: [
      'Each request is signed with a shared secret. A wrong signature is rejected with 401 and never retried.',
      'Mỗi request được ký bằng một khóa bí mật chung. Chữ ký sai bị từ chối với 401 và không bao giờ được thử lại.',
    ],
  },
];

const GUARANTEES: Array<{ icon: string; title: Pair; body: Pair }> = [
  {
    icon: '🧾',
    title: ['Transactional outbox', 'Transactional outbox'],
    body: [
      'The event, its delivery and an outbox row are saved in one PostgreSQL transaction before the API answers 202. If the process crashes right after, the outbox still has it.',
      'Event, delivery và một dòng outbox được lưu trong cùng một transaction PostgreSQL trước khi API trả 202. Tiến trình có sập ngay sau đó thì outbox vẫn còn giữ.',
    ],
  },
  {
    icon: '🗄️',
    title: ['PostgreSQL is the source of truth', 'PostgreSQL là nguồn sự thật'],
    body: [
      'Redis only wakes the worker. If Redis loses every job, a recovery loop re-sends from PostgreSQL.',
      'Redis chỉ dùng để đánh thức worker. Redis có mất hết job thì vòng lặp recovery sẽ gửi lại từ PostgreSQL.',
    ],
  },
  {
    icon: '🔑',
    title: ['Lease + fencing token', 'Lease + fencing token'],
    body: [
      'A worker must claim a delivery for a limited time. If it dies mid-send, the lease expires, the attempt is marked “worker lost” and another worker retries. The dead worker cannot overwrite the result if it comes back.',
      'Worker phải “giữ chỗ” (claim) delivery trong một khoảng thời gian. Nếu nó chết giữa chừng, lease hết hạn, lần thử bị ghi “mất worker” và worker khác thử lại. Worker cũ có sống lại cũng không ghi đè được kết quả.',
    ],
  },
  {
    icon: '🎯',
    title: [
      'At-least-once delivery, exactly-once effect',
      'Giao ít nhất một lần, effect đúng một lần',
    ],
    body: [
      'The system never promises a request arrives only once. It promises the effect is applied only once.',
      'Hệ thống không hứa request chỉ đến một lần. Nó hứa effect chỉ được áp dụng một lần.',
    ],
  },
];

const PATH: Pair[] = [
  [
    'A client POSTs an event. The API stores it in PostgreSQL and answers 202.',
    'Client POST một event. API lưu nó vào PostgreSQL và trả 202.',
  ],
  [
    'A dispatcher reads the outbox and pushes a job to the Redis queue.',
    'Dispatcher đọc outbox và đẩy job vào hàng đợi Redis.',
  ],
  [
    'A worker claims the delivery, signs the payload with HMAC and POSTs it.',
    'Worker claim delivery, ký payload bằng HMAC rồi POST đi.',
  ],
  [
    'The receiver checks the signature, applies the effect once, and answers 2xx. Anything else is retried or sent to dead letters.',
    'Receiver kiểm tra chữ ký, áp dụng effect một lần và trả 2xx. Trường hợp khác sẽ được thử lại hoặc đưa vào dead letters.',
  ],
];

export function HowItWorks() {
  const { t } = useLang();
  const stories = useStories();
  return (
    <>
      <PageTitle
        title={t('How it works', 'Cách hoạt động')}
        subtitle={t(
          'The ideas behind the lab in plain words. Five minutes of reading makes every other screen make sense.',
          'Các ý tưởng đằng sau lab, nói bằng lời dễ hiểu. Đọc 5 phút là hiểu mọi màn hình còn lại.',
        )}
      />

      <Panel title={t('The path of one event', 'Đường đi của một event')} className="mb-5">
        <PipelineDiagram />
        <ol className="mt-4 list-decimal space-y-1 pl-5 text-sm text-slate-300">
          {PATH.map((p) => (
            <li key={p[0]}>{t(...p)}</li>
          ))}
        </ol>
      </Panel>

      <div className="grid gap-5 lg:grid-cols-2">
        <Panel title={t('Words used on this dashboard', 'Các thuật ngữ trên dashboard')}>
          <dl className="space-y-3 text-sm">
            {TERMS.map(({ term, def }) => (
              <div key={term}>
                <dt className="font-semibold text-white">{term}</dt>
                <dd className="text-slate-300">{t(...def)}</dd>
              </div>
            ))}
          </dl>
        </Panel>

        <div className="space-y-5">
          <Panel
            title={t(
              'Why nothing gets lost or applied twice',
              'Vì sao không mất và không bị áp dụng 2 lần',
            )}
          >
            <ul className="space-y-4 text-sm">
              {GUARANTEES.map((g) => (
                <li key={g.icon} className="flex gap-3">
                  <span aria-hidden="true" className="text-xl leading-6">
                    {g.icon}
                  </span>
                  <div>
                    <p className="font-semibold text-white">{t(...g.title)}</p>
                    <p className="text-slate-300">{t(...g.body)}</p>
                  </div>
                </li>
              ))}
            </ul>
          </Panel>

          <Panel
            title={t('The 7 failures you can inject', '7 loại lỗi có thể gây ra')}
            action={
              <Link to="/runner" className="text-sm text-sky-300 hover:underline">
                {t('Try one →', 'Thử ngay →')}
              </Link>
            }
          >
            <ul className="space-y-2 text-sm">
              {SCENARIO_KEYS.map((k) => {
                const s = stories.story(k)!;
                return (
                  <li key={k} className="flex gap-2">
                    <span aria-hidden="true">{s.icon}</span>
                    <span className="text-slate-300">
                      <b className="text-white">{s.title}:</b> {s.breaks}{' '}
                      <span className="text-emerald-300">→ {s.mustHold}</span>
                    </span>
                  </li>
                );
              })}
            </ul>
          </Panel>
        </div>
      </div>
    </>
  );
}
