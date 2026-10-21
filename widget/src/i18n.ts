// 輕量多語系(i18n)機制:內建語系字典 + t(key, params?)。不引任何第三方。
//
// 用法:
//   const t = createTranslator(resolveLocale(cfg.locale));
//   t("send")                       // → 依 locale 取字串
//   t("fileTooLarge", { mb: 10, name: "a.png" })  // → 具名參數以 {name} 內插
//
// locale 決定順序(見 resolveLocale):
//   1) 顯式傳入(WidgetConfig.locale / data-locale)
//   2) navigator.language / navigator.languages 自動偵測
//   3) 回退預設 zh-Hant
//
// 每個語系皆為完整字典(TypeScript 以 Messages = Record<MessageKey,string> 強制
// 完整性:任一語系缺 key 都會編譯失敗),故 t() 不會有缺字。

// ---- 繁體中文為「標準字典」:其鍵集合即所有可翻譯字串的來源 ----
const zhHant = {
  // 氣泡 / 標頭 / 工具列
  bubbleAria: "開啟客服對話",
  title: "線上客服",
  greeting: "您好!請問有什麼可以幫您?",
  close: "關閉",
  endAndRate: "結束對話並評分",
  attach: "附加檔案",
  emoji: "表情符號",
  send: "送出",
  inputPlaceholder: "輸入訊息…",

  // 連線狀態
  statusDisconnected: "未連線",
  statusConnected: "已連線",
  statusConnecting: "連線中…",
  statusReconnecting: "重連中…",
  statusWsFailed: "WS 失敗",
  statusPolling: "輪詢中",
  statusOnline: "線上",
  statusOffline: "離線",

  // 系統 / 提示訊息
  noChannelKey: "尚未設定 channelKey,無法連線。",
  openSessionFailedPrefix: "建立會話失敗:",
  noSessionId: "後端未回傳 session_id(會話核心可能未就緒),仍可送訊但無法接收回覆。",
  noTenantPolling: "未設定 tenantId,改用輪詢接收回覆。",
  noReceive: "未設定 tenantId 或 agentToken:可送訊,但無法即時接收回覆。",
  wsFallbackPolling: "WebSocket 連不上,改用輪詢。",
  wsFailedNoPoll: "WebSocket 連不上,且無 agentToken 可輪詢。",
  sessionClosed: "會話已結束。",
  noSessionCannotSend: "尚未建立會話,無法送出。",
  sendFailedPrefix: "送出失敗:",

  // 附件 / 圖片
  image: "圖片",
  downloadAttachment: "下載附件",
  fileTooLarge: "檔案過大(上限 {mb}MB):{name}",
  noSessionCannotUpload: "尚未建立會話,無法上傳。",
  uploading: "上傳中…",
  uploadFailedPrefix: "上傳失敗:",

  // pre-chat 表單
  prechatIntro: "開始對話前,請先填寫以下資訊:",
  startChat: "開始對話",
  fieldRequired: "此欄位為必填",
  invalidEmail: "請輸入有效的 Email",
  fillMessage: "請填寫訊息內容",
  visitorInfo: "【訪客資料】\n{lines}",

  // 離線留言表單
  offlineDefault: "我們目前不在線上,留下 Email 與訊息,我們會盡快回覆您。",
  email: "Email",
  message: "訊息",
  emailPlaceholder: "you@example.com",
  describeIssue: "請描述您的問題…",
  submitMessage: "送出留言",
  submitting: "送出中…",
  offlineMessage: "【離線留言】\nEmail:{email}\n\n{body}",
  offlineReceived: "已收到,將盡快回覆您的 Email。",
  submitFailedRetry: "送出失敗,請稍後再試。",

  // CSAT 評分
  noConversationToRate: "目前沒有可評分的對話。",
  rateTitle: "為這次服務評分",
  rateSubtitle: "您的回饋幫助我們做得更好",
  starAria: "{n} 星",
  rateCommentPlaceholder: "想補充的話(選填)",
  later: "稍後再說",
  submitRating: "送出評分",
  rateThanks: "感謝您的評分!",
};

/** 所有可翻譯字串的鍵(以繁中字典為準)。 */
export type MessageKey = keyof typeof zhHant;

/** 單一語系字典:必須涵蓋全部 MessageKey(編譯期強制完整)。 */
export type Messages = Record<MessageKey, string>;

const zhHans: Messages = {
  bubbleAria: "打开客服对话",
  title: "在线客服",
  greeting: "您好!请问有什么可以帮您?",
  close: "关闭",
  endAndRate: "结束对话并评分",
  attach: "添加附件",
  emoji: "表情符号",
  send: "发送",
  inputPlaceholder: "输入消息…",

  statusDisconnected: "未连接",
  statusConnected: "已连接",
  statusConnecting: "连接中…",
  statusReconnecting: "重新连接中…",
  statusWsFailed: "WS 失败",
  statusPolling: "轮询中",
  statusOnline: "在线",
  statusOffline: "离线",

  noChannelKey: "尚未设置 channelKey,无法连接。",
  openSessionFailedPrefix: "创建会话失败:",
  noSessionId: "后端未返回 session_id(会话核心可能尚未就绪),仍可发送但无法接收回复。",
  noTenantPolling: "未设置 tenantId,改用轮询接收回复。",
  noReceive: "未设置 tenantId 或 agentToken:可发送,但无法实时接收回复。",
  wsFallbackPolling: "WebSocket 连接失败,改用轮询。",
  wsFailedNoPoll: "WebSocket 连接失败,且无 agentToken 可轮询。",
  sessionClosed: "会话已结束。",
  noSessionCannotSend: "尚未创建会话,无法发送。",
  sendFailedPrefix: "发送失败:",

  image: "图片",
  downloadAttachment: "下载附件",
  fileTooLarge: "文件过大(上限 {mb}MB):{name}",
  noSessionCannotUpload: "尚未创建会话,无法上传。",
  uploading: "上传中…",
  uploadFailedPrefix: "上传失败:",

  prechatIntro: "开始对话前,请先填写以下信息:",
  startChat: "开始对话",
  fieldRequired: "此项为必填",
  invalidEmail: "请输入有效的 Email",
  fillMessage: "请填写消息内容",
  visitorInfo: "【访客资料】\n{lines}",

  offlineDefault: "我们目前不在线,请留下 Email 与消息,我们会尽快回复您。",
  email: "Email",
  message: "消息",
  emailPlaceholder: "you@example.com",
  describeIssue: "请描述您的问题…",
  submitMessage: "提交留言",
  submitting: "提交中…",
  offlineMessage: "【离线留言】\nEmail:{email}\n\n{body}",
  offlineReceived: "已收到,将尽快回复您的 Email。",
  submitFailedRetry: "提交失败,请稍后再试。",

  noConversationToRate: "目前没有可评分的对话。",
  rateTitle: "为本次服务评分",
  rateSubtitle: "您的反馈帮助我们做得更好",
  starAria: "{n} 星",
  rateCommentPlaceholder: "想补充的话(选填)",
  later: "稍后再说",
  submitRating: "提交评分",
  rateThanks: "感谢您的评分!",
};

const en: Messages = {
  bubbleAria: "Open support chat",
  title: "Live Support",
  greeting: "Hello! How can we help you?",
  close: "Close",
  endAndRate: "End chat and rate",
  attach: "Attach file",
  emoji: "Emoji",
  send: "Send",
  inputPlaceholder: "Type a message…",

  statusDisconnected: "Disconnected",
  statusConnected: "Connected",
  statusConnecting: "Connecting…",
  statusReconnecting: "Reconnecting…",
  statusWsFailed: "WS failed",
  statusPolling: "Polling",
  statusOnline: "Online",
  statusOffline: "Offline",

  noChannelKey: "channelKey is not set; cannot connect.",
  openSessionFailedPrefix: "Failed to open session: ",
  noSessionId:
    "The server did not return a session_id (the conversation core may not be ready); you can still send messages but cannot receive replies.",
  noTenantPolling: "tenantId not set; falling back to polling for replies.",
  noReceive:
    "Neither tenantId nor agentToken is set: you can send, but cannot receive replies in real time.",
  wsFallbackPolling: "WebSocket is unavailable; falling back to polling.",
  wsFailedNoPoll: "WebSocket is unavailable, and there is no agentToken to poll with.",
  sessionClosed: "The conversation has ended.",
  noSessionCannotSend: "No session yet; cannot send.",
  sendFailedPrefix: "Failed to send: ",

  image: "Image",
  downloadAttachment: "Download attachment",
  fileTooLarge: "File too large (max {mb}MB): {name}",
  noSessionCannotUpload: "No session yet; cannot upload.",
  uploading: "Uploading…",
  uploadFailedPrefix: "Upload failed: ",

  prechatIntro: "Before we start, please fill in the following:",
  startChat: "Start chat",
  fieldRequired: "This field is required",
  invalidEmail: "Please enter a valid email",
  fillMessage: "Please enter your message",
  visitorInfo: "[Visitor info]\n{lines}",

  offlineDefault:
    "We're currently offline. Leave your email and a message, and we'll get back to you as soon as possible.",
  email: "Email",
  message: "Message",
  emailPlaceholder: "you@example.com",
  describeIssue: "Please describe your issue…",
  submitMessage: "Send message",
  submitting: "Sending…",
  offlineMessage: "[Offline message]\nEmail: {email}\n\n{body}",
  offlineReceived: "Got it — we'll reply to your email as soon as possible.",
  submitFailedRetry: "Failed to send. Please try again later.",

  noConversationToRate: "There's no conversation to rate yet.",
  rateTitle: "Rate this service",
  rateSubtitle: "Your feedback helps us improve",
  starAria: "{n} star",
  rateCommentPlaceholder: "Anything to add? (optional)",
  later: "Maybe later",
  submitRating: "Submit rating",
  rateThanks: "Thanks for your feedback!",
};

const ja: Messages = {
  bubbleAria: "サポートチャットを開く",
  title: "オンラインサポート",
  greeting: "こんにちは!ご用件をお聞かせください。",
  close: "閉じる",
  endAndRate: "チャットを終了して評価する",
  attach: "ファイルを添付",
  emoji: "絵文字",
  send: "送信",
  inputPlaceholder: "メッセージを入力…",

  statusDisconnected: "未接続",
  statusConnected: "接続済み",
  statusConnecting: "接続中…",
  statusReconnecting: "再接続中…",
  statusWsFailed: "WS 失敗",
  statusPolling: "ポーリング中",
  statusOnline: "オンライン",
  statusOffline: "オフライン",

  noChannelKey: "channelKey が設定されていないため接続できません。",
  openSessionFailedPrefix: "セッションの作成に失敗しました:",
  noSessionId:
    "サーバーが session_id を返しませんでした(会話コアが未準備の可能性)。送信は可能ですが返信は受信できません。",
  noTenantPolling: "tenantId が未設定のため、ポーリングで返信を受信します。",
  noReceive:
    "tenantId も agentToken も未設定です:送信は可能ですが、リアルタイムで返信を受信できません。",
  wsFallbackPolling: "WebSocket に接続できないため、ポーリングに切り替えます。",
  wsFailedNoPoll: "WebSocket に接続できず、ポーリング用の agentToken もありません。",
  sessionClosed: "会話が終了しました。",
  noSessionCannotSend: "セッションが未作成のため送信できません。",
  sendFailedPrefix: "送信に失敗しました:",

  image: "画像",
  downloadAttachment: "添付ファイルをダウンロード",
  fileTooLarge: "ファイルが大きすぎます(上限 {mb}MB):{name}",
  noSessionCannotUpload: "セッションが未作成のためアップロードできません。",
  uploading: "アップロード中…",
  uploadFailedPrefix: "アップロードに失敗しました:",

  prechatIntro: "会話を始める前に、以下の情報をご入力ください:",
  startChat: "チャットを開始",
  fieldRequired: "この項目は必須です",
  invalidEmail: "有効なメールアドレスを入力してください",
  fillMessage: "メッセージ内容をご記入ください",
  visitorInfo: "【訪問者情報】\n{lines}",

  offlineDefault:
    "現在オフラインです。メールアドレスとメッセージを残していただければ、できるだけ早くご返信します。",
  email: "メールアドレス",
  message: "メッセージ",
  emailPlaceholder: "you@example.com",
  describeIssue: "お問い合わせ内容をご記入ください…",
  submitMessage: "メッセージを送信",
  submitting: "送信中…",
  offlineMessage: "【オフラインメッセージ】\nメール:{email}\n\n{body}",
  offlineReceived: "承りました。メールにてできるだけ早くご返信します。",
  submitFailedRetry: "送信に失敗しました。しばらくしてから再度お試しください。",

  noConversationToRate: "評価できる会話がありません。",
  rateTitle: "このサービスを評価する",
  rateSubtitle: "いただいたご意見は改善に役立てます",
  starAria: "星 {n} つ",
  rateCommentPlaceholder: "ご意見があればご記入ください(任意)",
  later: "後で",
  submitRating: "評価を送信",
  rateThanks: "評価ありがとうございました!",
};

const ko: Messages = {
  bubbleAria: "고객 지원 채팅 열기",
  title: "온라인 상담",
  greeting: "안녕하세요! 무엇을 도와드릴까요?",
  close: "닫기",
  endAndRate: "대화 종료 후 평가하기",
  attach: "파일 첨부",
  emoji: "이모지",
  send: "보내기",
  inputPlaceholder: "메시지를 입력하세요…",

  statusDisconnected: "연결 안 됨",
  statusConnected: "연결됨",
  statusConnecting: "연결 중…",
  statusReconnecting: "다시 연결 중…",
  statusWsFailed: "WS 실패",
  statusPolling: "폴링 중",
  statusOnline: "온라인",
  statusOffline: "오프라인",

  noChannelKey: "channelKey가 설정되지 않아 연결할 수 없습니다.",
  openSessionFailedPrefix: "세션 생성 실패: ",
  noSessionId:
    "서버가 session_id를 반환하지 않았습니다(대화 코어가 준비되지 않았을 수 있음). 메시지는 보낼 수 있지만 답장을 받을 수 없습니다.",
  noTenantPolling: "tenantId가 설정되지 않아 폴링으로 답장을 받습니다.",
  noReceive:
    "tenantId와 agentToken이 모두 설정되지 않았습니다: 보낼 수는 있지만 실시간으로 답장을 받을 수 없습니다.",
  wsFallbackPolling: "WebSocket에 연결할 수 없어 폴링으로 전환합니다.",
  wsFailedNoPoll: "WebSocket에 연결할 수 없고 폴링에 사용할 agentToken도 없습니다.",
  sessionClosed: "대화가 종료되었습니다.",
  noSessionCannotSend: "아직 세션이 없어 보낼 수 없습니다.",
  sendFailedPrefix: "전송 실패: ",

  image: "이미지",
  downloadAttachment: "첨부파일 다운로드",
  fileTooLarge: "파일이 너무 큽니다(최대 {mb}MB): {name}",
  noSessionCannotUpload: "아직 세션이 없어 업로드할 수 없습니다.",
  uploading: "업로드 중…",
  uploadFailedPrefix: "업로드 실패: ",

  prechatIntro: "대화를 시작하기 전에 다음 정보를 입력해 주세요:",
  startChat: "대화 시작",
  fieldRequired: "필수 입력 항목입니다",
  invalidEmail: "유효한 이메일을 입력해 주세요",
  fillMessage: "메시지 내용을 입력해 주세요",
  visitorInfo: "【방문자 정보】\n{lines}",

  offlineDefault:
    "현재 오프라인입니다. 이메일과 메시지를 남겨 주시면 최대한 빨리 답변드리겠습니다.",
  email: "이메일",
  message: "메시지",
  emailPlaceholder: "you@example.com",
  describeIssue: "문의 내용을 입력해 주세요…",
  submitMessage: "메시지 보내기",
  submitting: "전송 중…",
  offlineMessage: "【오프라인 메시지】\n이메일: {email}\n\n{body}",
  offlineReceived: "접수되었습니다. 이메일로 최대한 빨리 답변드리겠습니다.",
  submitFailedRetry: "전송에 실패했습니다. 잠시 후 다시 시도해 주세요.",

  noConversationToRate: "평가할 대화가 없습니다.",
  rateTitle: "이번 서비스를 평가해 주세요",
  rateSubtitle: "여러분의 의견은 개선에 큰 도움이 됩니다",
  starAria: "별 {n}개",
  rateCommentPlaceholder: "추가로 남기실 말씀 (선택)",
  later: "나중에",
  submitRating: "평가 보내기",
  rateThanks: "평가해 주셔서 감사합니다!",
};

const es: Messages = {
  bubbleAria: "Abrir chat de soporte",
  title: "Soporte en línea",
  greeting: "¡Hola! ¿En qué podemos ayudarte?",
  close: "Cerrar",
  endAndRate: "Finalizar chat y valorar",
  attach: "Adjuntar archivo",
  emoji: "Emoji",
  send: "Enviar",
  inputPlaceholder: "Escribe un mensaje…",

  statusDisconnected: "Desconectado",
  statusConnected: "Conectado",
  statusConnecting: "Conectando…",
  statusReconnecting: "Reconectando…",
  statusWsFailed: "WS falló",
  statusPolling: "Sondeo",
  statusOnline: "En línea",
  statusOffline: "Sin conexión",

  noChannelKey: "channelKey no está configurado; no se puede conectar.",
  openSessionFailedPrefix: "No se pudo abrir la sesión: ",
  noSessionId:
    "El servidor no devolvió session_id (es posible que el núcleo de conversación no esté listo); puedes enviar mensajes pero no recibir respuestas.",
  noTenantPolling: "tenantId no configurado; se usará sondeo para recibir respuestas.",
  noReceive:
    "Ni tenantId ni agentToken están configurados: puedes enviar, pero no recibir respuestas en tiempo real.",
  wsFallbackPolling: "WebSocket no disponible; se usará sondeo.",
  wsFailedNoPoll: "WebSocket no disponible y sin agentToken para sondear.",
  sessionClosed: "La conversación ha finalizado.",
  noSessionCannotSend: "Aún no hay sesión; no se puede enviar.",
  sendFailedPrefix: "Error al enviar: ",

  image: "Imagen",
  downloadAttachment: "Descargar adjunto",
  fileTooLarge: "Archivo demasiado grande (máx. {mb}MB): {name}",
  noSessionCannotUpload: "Aún no hay sesión; no se puede subir.",
  uploading: "Subiendo…",
  uploadFailedPrefix: "Error al subir: ",

  prechatIntro: "Antes de empezar, completa la siguiente información:",
  startChat: "Iniciar chat",
  fieldRequired: "Este campo es obligatorio",
  invalidEmail: "Introduce un correo electrónico válido",
  fillMessage: "Introduce tu mensaje",
  visitorInfo: "[Datos del visitante]\n{lines}",

  offlineDefault:
    "Ahora mismo no estamos en línea. Déjanos tu correo y tu mensaje y te responderemos lo antes posible.",
  email: "Correo",
  message: "Mensaje",
  emailPlaceholder: "you@example.com",
  describeIssue: "Describe tu consulta…",
  submitMessage: "Enviar mensaje",
  submitting: "Enviando…",
  offlineMessage: "[Mensaje sin conexión]\nCorreo: {email}\n\n{body}",
  offlineReceived: "Recibido. Te responderemos por correo lo antes posible.",
  submitFailedRetry: "Error al enviar. Inténtalo de nuevo más tarde.",

  noConversationToRate: "Todavía no hay ninguna conversación para valorar.",
  rateTitle: "Valora este servicio",
  rateSubtitle: "Tu opinión nos ayuda a mejorar",
  starAria: "{n} estrellas",
  rateCommentPlaceholder: "¿Algo que añadir? (opcional)",
  later: "Más tarde",
  submitRating: "Enviar valoración",
  rateThanks: "¡Gracias por tu valoración!",
};

// 阿拉伯語(RTL,示範右至左方向支援)
const ar: Messages = {
  bubbleAria: "فتح محادثة الدعم",
  title: "الدعم عبر الإنترنت",
  greeting: "مرحبًا! كيف يمكننا مساعدتك؟",
  close: "إغلاق",
  endAndRate: "إنهاء المحادثة والتقييم",
  attach: "إرفاق ملف",
  emoji: "الرموز التعبيرية",
  send: "إرسال",
  inputPlaceholder: "اكتب رسالة…",

  statusDisconnected: "غير متصل",
  statusConnected: "متصل",
  statusConnecting: "جارٍ الاتصال…",
  statusReconnecting: "جارٍ إعادة الاتصال…",
  statusWsFailed: "فشل WS",
  statusPolling: "جارٍ الاستطلاع",
  statusOnline: "متصل",
  statusOffline: "غير متصل",

  noChannelKey: "لم يتم ضبط channelKey، تعذّر الاتصال.",
  openSessionFailedPrefix: "فشل بدء الجلسة: ",
  noSessionId:
    "لم يُرجع الخادم session_id (قد لا يكون نظام المحادثة جاهزًا)؛ يمكنك الإرسال لكن لا يمكنك استقبال الردود.",
  noTenantPolling: "لم يتم ضبط tenantId، سيتم استخدام الاستطلاع لاستقبال الردود.",
  noReceive:
    "لم يتم ضبط tenantId ولا agentToken: يمكنك الإرسال، لكن لا يمكنك استقبال الردود فوريًا.",
  wsFallbackPolling: "تعذّر الاتصال عبر WebSocket، سيتم التحويل إلى الاستطلاع.",
  wsFailedNoPoll: "تعذّر الاتصال عبر WebSocket، ولا يوجد agentToken للاستطلاع.",
  sessionClosed: "انتهت المحادثة.",
  noSessionCannotSend: "لا توجد جلسة بعد، تعذّر الإرسال.",
  sendFailedPrefix: "فشل الإرسال: ",

  image: "صورة",
  downloadAttachment: "تنزيل المرفق",
  fileTooLarge: "الملف كبير جدًا (الحد الأقصى {mb}MB): {name}",
  noSessionCannotUpload: "لا توجد جلسة بعد، تعذّر الرفع.",
  uploading: "جارٍ الرفع…",
  uploadFailedPrefix: "فشل الرفع: ",

  prechatIntro: "قبل البدء، يرجى تعبئة المعلومات التالية:",
  startChat: "بدء المحادثة",
  fieldRequired: "هذا الحقل مطلوب",
  invalidEmail: "يرجى إدخال بريد إلكتروني صالح",
  fillMessage: "يرجى إدخال نص الرسالة",
  visitorInfo: "【بيانات الزائر】\n{lines}",

  offlineDefault:
    "نحن غير متصلين حاليًا. اترك بريدك الإلكتروني ورسالتك وسنعاود التواصل معك في أقرب وقت.",
  email: "البريد الإلكتروني",
  message: "الرسالة",
  emailPlaceholder: "you@example.com",
  describeIssue: "يرجى وصف مشكلتك…",
  submitMessage: "إرسال الرسالة",
  submitting: "جارٍ الإرسال…",
  offlineMessage: "【رسالة دون اتصال】\nالبريد الإلكتروني: {email}\n\n{body}",
  offlineReceived: "تم الاستلام، وسنرد على بريدك الإلكتروني في أقرب وقت.",
  submitFailedRetry: "فشل الإرسال، يرجى المحاولة لاحقًا.",

  noConversationToRate: "لا توجد محادثة قابلة للتقييم حاليًا.",
  rateTitle: "قيّم هذه الخدمة",
  rateSubtitle: "ملاحظاتك تساعدنا على التحسّن",
  starAria: "{n} نجمة",
  rateCommentPlaceholder: "هل تريد إضافة شيء؟ (اختياري)",
  later: "لاحقًا",
  submitRating: "إرسال التقييم",
  rateThanks: "شكرًا على تقييمك!",
};

// 德語(de)
const de: Messages = {
  bubbleAria: "Support-Chat öffnen",
  title: "Live-Support",
  greeting: "Hallo! Wie können wir Ihnen helfen?",
  close: "Schließen",
  endAndRate: "Chat beenden und bewerten",
  attach: "Datei anhängen",
  emoji: "Emoji",
  send: "Senden",
  inputPlaceholder: "Nachricht eingeben…",

  statusDisconnected: "Getrennt",
  statusConnected: "Verbunden",
  statusConnecting: "Verbindung wird hergestellt…",
  statusReconnecting: "Erneute Verbindung…",
  statusWsFailed: "WS fehlgeschlagen",
  statusPolling: "Abfrage",
  statusOnline: "Online",
  statusOffline: "Offline",

  noChannelKey: "channelKey ist nicht gesetzt; Verbindung nicht möglich.",
  openSessionFailedPrefix: "Sitzung konnte nicht geöffnet werden: ",
  noSessionId:
    "Der Server hat keine session_id zurückgegeben (der Konversationskern ist möglicherweise nicht bereit). Sie können weiterhin Nachrichten senden, aber keine Antworten empfangen.",
  noTenantPolling: "tenantId nicht gesetzt; Antworten werden per Abfrage empfangen.",
  noReceive:
    "Weder tenantId noch agentToken ist gesetzt: Sie können senden, aber keine Antworten in Echtzeit empfangen.",
  wsFallbackPolling: "WebSocket nicht verfügbar; es wird auf Abfrage umgeschaltet.",
  wsFailedNoPoll: "WebSocket nicht verfügbar und kein agentToken für die Abfrage vorhanden.",
  sessionClosed: "Die Konversation wurde beendet.",
  noSessionCannotSend: "Noch keine Sitzung; Senden nicht möglich.",
  sendFailedPrefix: "Senden fehlgeschlagen: ",

  image: "Bild",
  downloadAttachment: "Anhang herunterladen",
  fileTooLarge: "Datei zu groß (max. {mb} MB): {name}",
  noSessionCannotUpload: "Noch keine Sitzung; Hochladen nicht möglich.",
  uploading: "Wird hochgeladen…",
  uploadFailedPrefix: "Hochladen fehlgeschlagen: ",

  prechatIntro: "Bevor wir beginnen, füllen Sie bitte die folgenden Angaben aus:",
  startChat: "Chat starten",
  fieldRequired: "Dieses Feld ist erforderlich",
  invalidEmail: "Bitte geben Sie eine gültige E-Mail-Adresse ein",
  fillMessage: "Bitte geben Sie Ihre Nachricht ein",
  visitorInfo: "[Besucherdaten]\n{lines}",

  offlineDefault:
    "Wir sind derzeit offline. Hinterlassen Sie Ihre E-Mail-Adresse und eine Nachricht, wir melden uns so schnell wie möglich.",
  email: "E-Mail",
  message: "Nachricht",
  emailPlaceholder: "you@example.com",
  describeIssue: "Bitte beschreiben Sie Ihr Anliegen…",
  submitMessage: "Nachricht senden",
  submitting: "Wird gesendet…",
  offlineMessage: "[Offline-Nachricht]\nE-Mail: {email}\n\n{body}",
  offlineReceived: "Erhalten – wir antworten Ihnen so schnell wie möglich per E-Mail.",
  submitFailedRetry: "Senden fehlgeschlagen. Bitte versuchen Sie es später erneut.",

  noConversationToRate: "Es gibt noch keine Konversation zum Bewerten.",
  rateTitle: "Diesen Service bewerten",
  rateSubtitle: "Ihr Feedback hilft uns, besser zu werden",
  starAria: "{n} Sterne",
  rateCommentPlaceholder: "Möchten Sie etwas hinzufügen? (optional)",
  later: "Später",
  submitRating: "Bewertung senden",
  rateThanks: "Vielen Dank für Ihre Bewertung!",
};

// 法語(fr)
const fr: Messages = {
  bubbleAria: "Ouvrir le chat d'assistance",
  title: "Assistance en ligne",
  greeting: "Bonjour ! Comment pouvons-nous vous aider ?",
  close: "Fermer",
  endAndRate: "Terminer le chat et évaluer",
  attach: "Joindre un fichier",
  emoji: "Émoji",
  send: "Envoyer",
  inputPlaceholder: "Saisissez un message…",

  statusDisconnected: "Déconnecté",
  statusConnected: "Connecté",
  statusConnecting: "Connexion…",
  statusReconnecting: "Reconnexion…",
  statusWsFailed: "Échec WS",
  statusPolling: "Interrogation",
  statusOnline: "En ligne",
  statusOffline: "Hors ligne",

  noChannelKey: "channelKey n'est pas défini ; connexion impossible.",
  openSessionFailedPrefix: "Échec de l'ouverture de la session : ",
  noSessionId:
    "Le serveur n'a pas renvoyé de session_id (le cœur de conversation n'est peut-être pas prêt) ; vous pouvez toujours envoyer des messages mais pas recevoir de réponses.",
  noTenantPolling: "tenantId non défini ; utilisation de l'interrogation pour recevoir les réponses.",
  noReceive:
    "Ni tenantId ni agentToken ne sont définis : vous pouvez envoyer, mais pas recevoir de réponses en temps réel.",
  wsFallbackPolling: "WebSocket indisponible ; passage à l'interrogation.",
  wsFailedNoPoll: "WebSocket indisponible et aucun agentToken pour l'interrogation.",
  sessionClosed: "La conversation est terminée.",
  noSessionCannotSend: "Pas encore de session ; envoi impossible.",
  sendFailedPrefix: "Échec de l'envoi : ",

  image: "Image",
  downloadAttachment: "Télécharger la pièce jointe",
  fileTooLarge: "Fichier trop volumineux (max. {mb} Mo) : {name}",
  noSessionCannotUpload: "Pas encore de session ; téléversement impossible.",
  uploading: "Téléversement…",
  uploadFailedPrefix: "Échec du téléversement : ",

  prechatIntro: "Avant de commencer, veuillez remplir les informations suivantes :",
  startChat: "Démarrer le chat",
  fieldRequired: "Ce champ est obligatoire",
  invalidEmail: "Veuillez saisir une adresse e-mail valide",
  fillMessage: "Veuillez saisir votre message",
  visitorInfo: "[Informations du visiteur]\n{lines}",

  offlineDefault:
    "Nous sommes actuellement hors ligne. Laissez votre e-mail et un message, nous vous répondrons dès que possible.",
  email: "E-mail",
  message: "Message",
  emailPlaceholder: "you@example.com",
  describeIssue: "Veuillez décrire votre problème…",
  submitMessage: "Envoyer le message",
  submitting: "Envoi…",
  offlineMessage: "[Message hors ligne]\nE-mail : {email}\n\n{body}",
  offlineReceived: "Bien reçu — nous vous répondrons par e-mail dès que possible.",
  submitFailedRetry: "Échec de l'envoi. Veuillez réessayer plus tard.",

  noConversationToRate: "Il n'y a pas encore de conversation à évaluer.",
  rateTitle: "Évaluer ce service",
  rateSubtitle: "Vos retours nous aident à nous améliorer",
  starAria: "{n} étoiles",
  rateCommentPlaceholder: "Quelque chose à ajouter ? (facultatif)",
  later: "Plus tard",
  submitRating: "Envoyer l'évaluation",
  rateThanks: "Merci pour votre évaluation !",
};

// 葡萄牙語(pt)
const pt: Messages = {
  bubbleAria: "Abrir chat de suporte",
  title: "Suporte online",
  greeting: "Olá! Como podemos ajudar?",
  close: "Fechar",
  endAndRate: "Encerrar chat e avaliar",
  attach: "Anexar arquivo",
  emoji: "Emoji",
  send: "Enviar",
  inputPlaceholder: "Digite uma mensagem…",

  statusDisconnected: "Desconectado",
  statusConnected: "Conectado",
  statusConnecting: "Conectando…",
  statusReconnecting: "Reconectando…",
  statusWsFailed: "Falha no WS",
  statusPolling: "Sondagem",
  statusOnline: "Online",
  statusOffline: "Offline",

  noChannelKey: "channelKey não está definido; não é possível conectar.",
  openSessionFailedPrefix: "Falha ao abrir a sessão: ",
  noSessionId:
    "O servidor não retornou um session_id (o núcleo de conversa pode não estar pronto); você ainda pode enviar mensagens, mas não pode receber respostas.",
  noTenantPolling: "tenantId não definido; usando sondagem para receber respostas.",
  noReceive:
    "Nem tenantId nem agentToken estão definidos: você pode enviar, mas não pode receber respostas em tempo real.",
  wsFallbackPolling: "WebSocket indisponível; alternando para sondagem.",
  wsFailedNoPoll: "WebSocket indisponível e sem agentToken para sondagem.",
  sessionClosed: "A conversa foi encerrada.",
  noSessionCannotSend: "Ainda não há sessão; não é possível enviar.",
  sendFailedPrefix: "Falha ao enviar: ",

  image: "Imagem",
  downloadAttachment: "Baixar anexo",
  fileTooLarge: "Arquivo muito grande (máx. {mb} MB): {name}",
  noSessionCannotUpload: "Ainda não há sessão; não é possível enviar o arquivo.",
  uploading: "Enviando…",
  uploadFailedPrefix: "Falha no envio: ",

  prechatIntro: "Antes de começar, preencha as seguintes informações:",
  startChat: "Iniciar chat",
  fieldRequired: "Este campo é obrigatório",
  invalidEmail: "Insira um e-mail válido",
  fillMessage: "Digite sua mensagem",
  visitorInfo: "[Dados do visitante]\n{lines}",

  offlineDefault:
    "No momento estamos offline. Deixe seu e-mail e uma mensagem, e responderemos o mais rápido possível.",
  email: "E-mail",
  message: "Mensagem",
  emailPlaceholder: "you@example.com",
  describeIssue: "Descreva seu problema…",
  submitMessage: "Enviar mensagem",
  submitting: "Enviando…",
  offlineMessage: "[Mensagem offline]\nE-mail: {email}\n\n{body}",
  offlineReceived: "Recebido — responderemos ao seu e-mail o mais rápido possível.",
  submitFailedRetry: "Falha ao enviar. Tente novamente mais tarde.",

  noConversationToRate: "Ainda não há conversa para avaliar.",
  rateTitle: "Avalie este atendimento",
  rateSubtitle: "Seu feedback nos ajuda a melhorar",
  starAria: "{n} estrelas",
  rateCommentPlaceholder: "Algo a acrescentar? (opcional)",
  later: "Mais tarde",
  submitRating: "Enviar avaliação",
  rateThanks: "Obrigado pela sua avaliação!",
};

// 俄語(ru)
const ru: Messages = {
  bubbleAria: "Открыть чат поддержки",
  title: "Онлайн-поддержка",
  greeting: "Здравствуйте! Чем можем помочь?",
  close: "Закрыть",
  endAndRate: "Завершить чат и оценить",
  attach: "Прикрепить файл",
  emoji: "Эмодзи",
  send: "Отправить",
  inputPlaceholder: "Введите сообщение…",

  statusDisconnected: "Отключено",
  statusConnected: "Подключено",
  statusConnecting: "Подключение…",
  statusReconnecting: "Переподключение…",
  statusWsFailed: "Сбой WS",
  statusPolling: "Опрос",
  statusOnline: "В сети",
  statusOffline: "Не в сети",

  noChannelKey: "channelKey не задан; подключение невозможно.",
  openSessionFailedPrefix: "Не удалось открыть сессию: ",
  noSessionId:
    "Сервер не вернул session_id (ядро диалога может быть не готово); вы можете отправлять сообщения, но не можете получать ответы.",
  noTenantPolling: "tenantId не задан; ответы будут получаться через опрос.",
  noReceive:
    "Ни tenantId, ни agentToken не заданы: вы можете отправлять, но не можете получать ответы в реальном времени.",
  wsFallbackPolling: "WebSocket недоступен; переключение на опрос.",
  wsFailedNoPoll: "WebSocket недоступен, и нет agentToken для опроса.",
  sessionClosed: "Разговор завершён.",
  noSessionCannotSend: "Сессии ещё нет; отправка невозможна.",
  sendFailedPrefix: "Не удалось отправить: ",

  image: "Изображение",
  downloadAttachment: "Скачать вложение",
  fileTooLarge: "Файл слишком большой (макс. {mb} МБ): {name}",
  noSessionCannotUpload: "Сессии ещё нет; загрузка невозможна.",
  uploading: "Загрузка…",
  uploadFailedPrefix: "Не удалось загрузить: ",

  prechatIntro: "Прежде чем начать, заполните следующие данные:",
  startChat: "Начать чат",
  fieldRequired: "Это поле обязательно",
  invalidEmail: "Введите действительный адрес эл. почты",
  fillMessage: "Введите сообщение",
  visitorInfo: "[Данные посетителя]\n{lines}",

  offlineDefault:
    "Сейчас мы не в сети. Оставьте свой адрес эл. почты и сообщение, и мы ответим вам как можно скорее.",
  email: "Эл. почта",
  message: "Сообщение",
  emailPlaceholder: "you@example.com",
  describeIssue: "Опишите вашу проблему…",
  submitMessage: "Отправить сообщение",
  submitting: "Отправка…",
  offlineMessage: "[Офлайн-сообщение]\nЭл. почта: {email}\n\n{body}",
  offlineReceived: "Получено — мы ответим на вашу эл. почту как можно скорее.",
  submitFailedRetry: "Не удалось отправить. Повторите попытку позже.",

  noConversationToRate: "Пока нет разговора для оценки.",
  rateTitle: "Оцените обслуживание",
  rateSubtitle: "Ваш отзыв помогает нам стать лучше",
  starAria: "{n} звёзд",
  rateCommentPlaceholder: "Хотите что-то добавить? (необязательно)",
  later: "Позже",
  submitRating: "Отправить оценку",
  rateThanks: "Спасибо за вашу оценку!",
};

// 泰語(th)
const th: Messages = {
  bubbleAria: "เปิดแชทฝ่ายสนับสนุน",
  title: "ฝ่ายสนับสนุนออนไลน์",
  greeting: "สวัสดี! เราช่วยอะไรคุณได้บ้าง?",
  close: "ปิด",
  endAndRate: "จบการสนทนาและให้คะแนน",
  attach: "แนบไฟล์",
  emoji: "อีโมจิ",
  send: "ส่ง",
  inputPlaceholder: "พิมพ์ข้อความ…",

  statusDisconnected: "ไม่ได้เชื่อมต่อ",
  statusConnected: "เชื่อมต่อแล้ว",
  statusConnecting: "กำลังเชื่อมต่อ…",
  statusReconnecting: "กำลังเชื่อมต่อใหม่…",
  statusWsFailed: "WS ล้มเหลว",
  statusPolling: "กำลังโพลล์",
  statusOnline: "ออนไลน์",
  statusOffline: "ออฟไลน์",

  noChannelKey: "ยังไม่ได้ตั้งค่า channelKey จึงเชื่อมต่อไม่ได้",
  openSessionFailedPrefix: "เปิดเซสชันไม่สำเร็จ: ",
  noSessionId:
    "เซิร์ฟเวอร์ไม่ได้ส่ง session_id กลับมา (ระบบสนทนาอาจยังไม่พร้อม) คุณยังส่งข้อความได้แต่จะไม่ได้รับการตอบกลับ",
  noTenantPolling: "ยังไม่ได้ตั้งค่า tenantId จะใช้การโพลล์เพื่อรับการตอบกลับ",
  noReceive:
    "ยังไม่ได้ตั้งค่าทั้ง tenantId และ agentToken: คุณส่งได้ แต่จะไม่ได้รับการตอบกลับแบบเรียลไทม์",
  wsFallbackPolling: "เชื่อมต่อ WebSocket ไม่ได้ จะเปลี่ยนไปใช้การโพลล์",
  wsFailedNoPoll: "เชื่อมต่อ WebSocket ไม่ได้ และไม่มี agentToken สำหรับการโพลล์",
  sessionClosed: "การสนทนาสิ้นสุดแล้ว",
  noSessionCannotSend: "ยังไม่มีเซสชัน จึงส่งไม่ได้",
  sendFailedPrefix: "ส่งไม่สำเร็จ: ",

  image: "รูปภาพ",
  downloadAttachment: "ดาวน์โหลดไฟล์แนบ",
  fileTooLarge: "ไฟล์ใหญ่เกินไป (สูงสุด {mb}MB): {name}",
  noSessionCannotUpload: "ยังไม่มีเซสชัน จึงอัปโหลดไม่ได้",
  uploading: "กำลังอัปโหลด…",
  uploadFailedPrefix: "อัปโหลดไม่สำเร็จ: ",

  prechatIntro: "ก่อนเริ่มการสนทนา กรุณากรอกข้อมูลต่อไปนี้:",
  startChat: "เริ่มการสนทนา",
  fieldRequired: "จำเป็นต้องกรอกช่องนี้",
  invalidEmail: "กรุณากรอกอีเมลที่ถูกต้อง",
  fillMessage: "กรุณากรอกข้อความ",
  visitorInfo: "[ข้อมูลผู้เยี่ยมชม]\n{lines}",

  offlineDefault:
    "ขณะนี้เราออฟไลน์อยู่ กรุณาฝากอีเมลและข้อความไว้ แล้วเราจะติดต่อกลับโดยเร็วที่สุด",
  email: "อีเมล",
  message: "ข้อความ",
  emailPlaceholder: "you@example.com",
  describeIssue: "กรุณาอธิบายปัญหาของคุณ…",
  submitMessage: "ส่งข้อความ",
  submitting: "กำลังส่ง…",
  offlineMessage: "[ข้อความออฟไลน์]\nอีเมล: {email}\n\n{body}",
  offlineReceived: "ได้รับแล้ว เราจะตอบกลับทางอีเมลโดยเร็วที่สุด",
  submitFailedRetry: "ส่งไม่สำเร็จ กรุณาลองใหม่อีกครั้งภายหลัง",

  noConversationToRate: "ยังไม่มีการสนทนาให้ให้คะแนน",
  rateTitle: "ให้คะแนนบริการนี้",
  rateSubtitle: "ความคิดเห็นของคุณช่วยให้เราพัฒนาให้ดีขึ้น",
  starAria: "{n} ดาว",
  rateCommentPlaceholder: "มีอะไรจะเพิ่มเติมไหม? (ไม่บังคับ)",
  later: "ไว้ภายหลัง",
  submitRating: "ส่งคะแนน",
  rateThanks: "ขอบคุณสำหรับคะแนนของคุณ!",
};

// 越南語(vi)
const vi: Messages = {
  bubbleAria: "Mở trò chuyện hỗ trợ",
  title: "Hỗ trợ trực tuyến",
  greeting: "Xin chào! Chúng tôi có thể giúp gì cho bạn?",
  close: "Đóng",
  endAndRate: "Kết thúc trò chuyện và đánh giá",
  attach: "Đính kèm tệp",
  emoji: "Biểu tượng cảm xúc",
  send: "Gửi",
  inputPlaceholder: "Nhập tin nhắn…",

  statusDisconnected: "Đã ngắt kết nối",
  statusConnected: "Đã kết nối",
  statusConnecting: "Đang kết nối…",
  statusReconnecting: "Đang kết nối lại…",
  statusWsFailed: "WS thất bại",
  statusPolling: "Đang thăm dò",
  statusOnline: "Trực tuyến",
  statusOffline: "Ngoại tuyến",

  noChannelKey: "Chưa đặt channelKey; không thể kết nối.",
  openSessionFailedPrefix: "Không thể mở phiên: ",
  noSessionId:
    "Máy chủ không trả về session_id (lõi hội thoại có thể chưa sẵn sàng); bạn vẫn có thể gửi tin nhắn nhưng không nhận được phản hồi.",
  noTenantPolling: "Chưa đặt tenantId; sẽ dùng thăm dò để nhận phản hồi.",
  noReceive:
    "Chưa đặt cả tenantId lẫn agentToken: bạn có thể gửi, nhưng không thể nhận phản hồi theo thời gian thực.",
  wsFallbackPolling: "WebSocket không khả dụng; chuyển sang thăm dò.",
  wsFailedNoPoll: "WebSocket không khả dụng và không có agentToken để thăm dò.",
  sessionClosed: "Cuộc trò chuyện đã kết thúc.",
  noSessionCannotSend: "Chưa có phiên; không thể gửi.",
  sendFailedPrefix: "Gửi thất bại: ",

  image: "Hình ảnh",
  downloadAttachment: "Tải tệp đính kèm",
  fileTooLarge: "Tệp quá lớn (tối đa {mb}MB): {name}",
  noSessionCannotUpload: "Chưa có phiên; không thể tải lên.",
  uploading: "Đang tải lên…",
  uploadFailedPrefix: "Tải lên thất bại: ",

  prechatIntro: "Trước khi bắt đầu, vui lòng điền các thông tin sau:",
  startChat: "Bắt đầu trò chuyện",
  fieldRequired: "Trường này là bắt buộc",
  invalidEmail: "Vui lòng nhập email hợp lệ",
  fillMessage: "Vui lòng nhập nội dung tin nhắn",
  visitorInfo: "[Thông tin khách]\n{lines}",

  offlineDefault:
    "Hiện chúng tôi đang ngoại tuyến. Hãy để lại email và tin nhắn, chúng tôi sẽ phản hồi sớm nhất có thể.",
  email: "Email",
  message: "Tin nhắn",
  emailPlaceholder: "you@example.com",
  describeIssue: "Vui lòng mô tả vấn đề của bạn…",
  submitMessage: "Gửi tin nhắn",
  submitting: "Đang gửi…",
  offlineMessage: "[Tin nhắn ngoại tuyến]\nEmail: {email}\n\n{body}",
  offlineReceived: "Đã nhận — chúng tôi sẽ phản hồi qua email sớm nhất có thể.",
  submitFailedRetry: "Gửi thất bại. Vui lòng thử lại sau.",

  noConversationToRate: "Chưa có cuộc trò chuyện nào để đánh giá.",
  rateTitle: "Đánh giá dịch vụ này",
  rateSubtitle: "Phản hồi của bạn giúp chúng tôi cải thiện",
  starAria: "{n} sao",
  rateCommentPlaceholder: "Bạn muốn bổ sung điều gì? (tùy chọn)",
  later: "Để sau",
  submitRating: "Gửi đánh giá",
  rateThanks: "Cảm ơn đánh giá của bạn!",
};

// 印尼語(id)
const id: Messages = {
  bubbleAria: "Buka obrolan dukungan",
  title: "Dukungan Online",
  greeting: "Halo! Ada yang bisa kami bantu?",
  close: "Tutup",
  endAndRate: "Akhiri obrolan dan beri nilai",
  attach: "Lampirkan berkas",
  emoji: "Emoji",
  send: "Kirim",
  inputPlaceholder: "Ketik pesan…",

  statusDisconnected: "Terputus",
  statusConnected: "Terhubung",
  statusConnecting: "Menghubungkan…",
  statusReconnecting: "Menghubungkan ulang…",
  statusWsFailed: "WS gagal",
  statusPolling: "Menjajaki",
  statusOnline: "Online",
  statusOffline: "Offline",

  noChannelKey: "channelKey belum diatur; tidak dapat terhubung.",
  openSessionFailedPrefix: "Gagal membuka sesi: ",
  noSessionId:
    "Server tidak mengembalikan session_id (inti percakapan mungkin belum siap); Anda masih dapat mengirim pesan tetapi tidak dapat menerima balasan.",
  noTenantPolling: "tenantId belum diatur; menggunakan penjajakan untuk menerima balasan.",
  noReceive:
    "Baik tenantId maupun agentToken belum diatur: Anda dapat mengirim, tetapi tidak dapat menerima balasan secara real-time.",
  wsFallbackPolling: "WebSocket tidak tersedia; beralih ke penjajakan.",
  wsFailedNoPoll: "WebSocket tidak tersedia, dan tidak ada agentToken untuk penjajakan.",
  sessionClosed: "Percakapan telah berakhir.",
  noSessionCannotSend: "Belum ada sesi; tidak dapat mengirim.",
  sendFailedPrefix: "Gagal mengirim: ",

  image: "Gambar",
  downloadAttachment: "Unduh lampiran",
  fileTooLarge: "Berkas terlalu besar (maks. {mb}MB): {name}",
  noSessionCannotUpload: "Belum ada sesi; tidak dapat mengunggah.",
  uploading: "Mengunggah…",
  uploadFailedPrefix: "Gagal mengunggah: ",

  prechatIntro: "Sebelum mulai, mohon isi informasi berikut:",
  startChat: "Mulai obrolan",
  fieldRequired: "Kolom ini wajib diisi",
  invalidEmail: "Masukkan email yang valid",
  fillMessage: "Mohon isi pesan Anda",
  visitorInfo: "[Info pengunjung]\n{lines}",

  offlineDefault:
    "Saat ini kami sedang offline. Tinggalkan email dan pesan Anda, kami akan segera membalas.",
  email: "Email",
  message: "Pesan",
  emailPlaceholder: "you@example.com",
  describeIssue: "Mohon jelaskan masalah Anda…",
  submitMessage: "Kirim pesan",
  submitting: "Mengirim…",
  offlineMessage: "[Pesan offline]\nEmail: {email}\n\n{body}",
  offlineReceived: "Diterima — kami akan membalas email Anda sesegera mungkin.",
  submitFailedRetry: "Gagal mengirim. Silakan coba lagi nanti.",

  noConversationToRate: "Belum ada percakapan untuk dinilai.",
  rateTitle: "Nilai layanan ini",
  rateSubtitle: "Masukan Anda membantu kami menjadi lebih baik",
  starAria: "{n} bintang",
  rateCommentPlaceholder: "Ada yang ingin ditambahkan? (opsional)",
  later: "Nanti saja",
  submitRating: "Kirim penilaian",
  rateThanks: "Terima kasih atas penilaian Anda!",
};

/** 內建語系字典表(鍵為正規化後的 locale)。 */
const tr: Messages = {
  "bubbleAria": "Destek sohbetini aç",
  "title": "Canlı Destek",
  "greeting": "Merhaba! Size nasıl yardımcı olabiliriz?",
  "close": "Kapat",
  "endAndRate": "Sohbeti bitir ve değerlendir",
  "attach": "Dosya ekle",
  "emoji": "Emoji",
  "send": "Gönder",
  "inputPlaceholder": "Bir mesaj yazın…",
  "statusDisconnected": "Bağlantı kesildi",
  "statusConnected": "Bağlandı",
  "statusConnecting": "Bağlanıyor…",
  "statusReconnecting": "Yeniden bağlanıyor…",
  "statusWsFailed": "WS başarısız",
  "statusPolling": "Yoklama",
  "statusOnline": "Çevrimiçi",
  "statusOffline": "Çevrimdışı",
  "noChannelKey": "channelKey ayarlanmadı; bağlanılamıyor.",
  "openSessionFailedPrefix": "Oturum açılamadı: ",
  "noSessionId": "Sunucu bir session_id döndürmedi (görüşme çekirdeği hazır olmayabilir); yine de mesaj gönderebilirsiniz ancak yanıt alamazsınız.",
  "noTenantPolling": "tenantId ayarlanmadı; yanıtları almak için yoklamaya geçiliyor.",
  "noReceive": "Ne tenantId ne de agentToken ayarlandı: gönderebilirsiniz, ancak yanıtları gerçek zamanlı olarak alamazsınız.",
  "wsFallbackPolling": "WebSocket kullanılamıyor; yoklamaya geçiliyor.",
  "wsFailedNoPoll": "WebSocket kullanılamıyor ve yoklama için agentToken yok.",
  "sessionClosed": "Görüşme sona erdi.",
  "noSessionCannotSend": "Henüz oturum yok; gönderilemiyor.",
  "sendFailedPrefix": "Gönderilemedi: ",
  "image": "Görsel",
  "downloadAttachment": "Eki indir",
  "fileTooLarge": "Dosya çok büyük (en fazla {mb}MB): {name}",
  "noSessionCannotUpload": "Henüz oturum yok; yüklenemiyor.",
  "uploading": "Yükleniyor…",
  "uploadFailedPrefix": "Yükleme başarısız: ",
  "prechatIntro": "Başlamadan önce, lütfen aşağıdaki bilgileri doldurun:",
  "startChat": "Sohbeti başlat",
  "fieldRequired": "Bu alan zorunludur",
  "invalidEmail": "Lütfen geçerli bir e-posta girin",
  "fillMessage": "Lütfen mesajınızı girin",
  "visitorInfo": "[Ziyaretçi bilgileri]\n{lines}",
  "offlineDefault": "Şu anda çevrimdışıyız. E-posta adresinizi ve bir mesaj bırakın, en kısa sürede size geri dönelim.",
  "email": "E-posta",
  "message": "Mesaj",
  "emailPlaceholder": "you@example.com",
  "describeIssue": "Lütfen sorununuzu açıklayın…",
  "submitMessage": "Mesaj gönder",
  "submitting": "Gönderiliyor…",
  "offlineMessage": "[Çevrimdışı mesaj]\nE-posta: {email}\n\n{body}",
  "offlineReceived": "Alındı — en kısa sürede e-postanıza yanıt vereceğiz.",
  "submitFailedRetry": "Gönderilemedi. Lütfen daha sonra tekrar deneyin.",
  "noConversationToRate": "Henüz değerlendirilecek bir görüşme yok.",
  "rateTitle": "Bu hizmeti değerlendirin",
  "rateSubtitle": "Geri bildiriminiz gelişmemize yardımcı olur",
  "starAria": "{n} yıldız",
  "rateCommentPlaceholder": "Eklemek istediğiniz bir şey var mı? (isteğe bağlı)",
  "later": "Belki sonra",
  "submitRating": "Değerlendirmeyi gönder",
  "rateThanks": "Geri bildiriminiz için teşekkürler!"
};

const hy: Messages = {
  "bubbleAria": "Բացել աջակցության զրույցը",
  "title": "Առցանց աջակցություն",
  "greeting": "Բարև։ Ինչո՞վ կարող ենք օգնել ձեզ։",
  "close": "Փակել",
  "endAndRate": "Ավարտել զրույցը և գնահատել",
  "attach": "Կցել ֆայլ",
  "emoji": "Էմոջի",
  "send": "Ուղարկել",
  "inputPlaceholder": "Մուտքագրեք հաղորդագրություն…",
  "statusDisconnected": "Անջատված",
  "statusConnected": "Միացված",
  "statusConnecting": "Միանում…",
  "statusReconnecting": "Վերամիանում…",
  "statusWsFailed": "WS ձախողվեց",
  "statusPolling": "Հարցում",
  "statusOnline": "Առցանց",
  "statusOffline": "Անցանց",
  "noChannelKey": "channelKey սահմանված չէ. հնարավոր չէ միանալ։",
  "openSessionFailedPrefix": "Չհաջողվեց բացել սեսիան՝ ",
  "noSessionId": "Սերվերը չվերադարձրեց session_id (զրույցի միջուկը հնարավոր է պատրաստ չէ). կարող եք դեռ հաղորդագրություններ ուղարկել, բայց չեք կարող ստանալ պատասխաններ։",
  "noTenantPolling": "tenantId սահմանված չէ. պատասխանների համար անցում հարցման (polling) ռեժիմին։",
  "noReceive": "Ո՛չ tenantId, ո՛չ agentToken սահմանված են՝ կարող եք ուղարկել, բայց չեք կարող իրական ժամանակում ստանալ պատասխաններ։",
  "wsFallbackPolling": "WebSocket-ն անհասանելի է. անցում հարցման (polling) ռեժիմին։",
  "wsFailedNoPoll": "WebSocket-ն անհասանելի է, և հարցում կատարելու համար agentToken չկա։",
  "sessionClosed": "Զրույցն ավարտվել է։",
  "noSessionCannotSend": "Դեռ սեսիա չկա. հնարավոր չէ ուղարկել։",
  "sendFailedPrefix": "Չհաջողվեց ուղարկել՝ ",
  "image": "Նկար",
  "downloadAttachment": "Ներբեռնել կցորդը",
  "fileTooLarge": "Ֆայլը չափազանց մեծ է (առավելագույնը {mb}MB)՝ {name}",
  "noSessionCannotUpload": "Դեռ սեսիա չկա. հնարավոր չէ վերբեռնել։",
  "uploading": "Վերբեռնվում է…",
  "uploadFailedPrefix": "Վերբեռնումը ձախողվեց՝ ",
  "prechatIntro": "Նախքան սկսելը, խնդրում ենք լրացնել հետևյալը՝",
  "startChat": "Սկսել զրույցը",
  "fieldRequired": "Այս դաշտը պարտադիր է",
  "invalidEmail": "Խնդրում ենք մուտքագրել վավեր Email",
  "fillMessage": "Խնդրում ենք մուտքագրել ձեր հաղորդագրությունը",
  "visitorInfo": "[Այցելուի տվյալներ]\n{lines}",
  "offlineDefault": "Այս պահին անցանց ենք։ Թողեք ձեր Email-ը և հաղորդագրություն, և մենք հնարավորինս շուտ կպատասխանենք ձեզ։",
  "email": "Email",
  "message": "Հաղորդագրություն",
  "emailPlaceholder": "you@example.com",
  "describeIssue": "Խնդրում ենք նկարագրել ձեր խնդիրը…",
  "submitMessage": "Ուղարկել հաղորդագրություն",
  "submitting": "Ուղարկվում է…",
  "offlineMessage": "[Անցանց հաղորդագրություն]\nEmail՝ {email}\n\n{body}",
  "offlineReceived": "Ստացվեց — հնարավորինս շուտ կպատասխանենք ձեր Email-ին։",
  "submitFailedRetry": "Չհաջողվեց ուղարկել։ Փորձեք ավելի ուշ։",
  "noConversationToRate": "Դեռ գնահատելու զրույց չկա։",
  "rateTitle": "Գնահատեք այս սպասարկումը",
  "rateSubtitle": "Ձեր կարծիքն օգնում է մեզ բարելավվել",
  "starAria": "{n} աստղ",
  "rateCommentPlaceholder": "Ցանկանո՞ւմ եք ինչ-որ բան ավելացնել։ (ըստ ցանկության)",
  "later": "Միգուցե ավելի ուշ",
  "submitRating": "Ուղարկել գնահատականը",
  "rateThanks": "Շնորհակալություն ձեր կարծիքի համար։"
};

const DICTIONARIES: Record<string, Messages> = {
  "zh-Hant": zhHant,
  "zh-CN": zhHans,
  en,
  ja,
  ko,
  es,
  ar,
  de,
  fr,
  pt,
  ru,
  th,
  vi,
  id,
  tr,
  hy,
};

/** 未指定且無法偵測時的預設語系。 */
export const DEFAULT_LOCALE = "zh-Hant";

/** 支援的語系代碼(對外可列舉)。 */
export const SUPPORTED_LOCALES = Object.keys(DICTIONARIES);

/** RTL(右至左)語系集合;可據此設定容器 direction。 */
const RTL_LOCALES = new Set(["ar", "he", "fa", "ur"]);

/** 判斷正規化後的 locale 是否為 RTL。 */
export function isRtlLocale(locale: string): boolean {
  return RTL_LOCALES.has(locale) || RTL_LOCALES.has(baseLang(locale));
}

/** 取語言主碼(小寫),例 "en-US" → "en"、"ZH-HANT" → "zh"。 */
function baseLang(tag: string): string {
  return (tag || "").toLowerCase().split(/[-_]/)[0];
}

/**
 * 把任意 BCP-47 語言標記正規化成內建支援的 locale 鍵;無法對應則回 null。
 * 處理常見別名:zh-TW/zh-HK/zh-Hant → zh-Hant;zh-CN/zh-SG/zh-Hans → zh-CN 等。
 */
function normalizeLocale(tag: string | undefined | null): string | null {
  if (!tag) return null;
  const raw = tag.trim();
  if (!raw) return null;
  // 完全命中(大小寫不敏感)
  const lower = raw.toLowerCase();
  for (const key of Object.keys(DICTIONARIES)) {
    if (key.toLowerCase() === lower) return key;
  }
  const parts = lower.split(/[-_]/);
  const lang = parts[0];
  const rest = parts.slice(1);
  if (lang === "zh") {
    // 依 script / region 判別繁簡
    const hasHant = rest.includes("hant") || rest.includes("tw") || rest.includes("hk") || rest.includes("mo");
    const hasHans = rest.includes("hans") || rest.includes("cn") || rest.includes("sg") || rest.includes("my");
    if (hasHant) return "zh-Hant";
    if (hasHans) return "zh-CN";
    // 純 "zh" 無地區:預設繁中(與整體預設一致)
    return "zh-Hant";
  }
  // 其餘語系以主碼對應(en-US → en、ja-JP → ja …)
  if (DICTIONARIES[lang]) return lang;
  return null;
}

/**
 * 決定最終使用的 locale。
 * 順序:顯式 configLocale → navigator.language(s) 逐一嘗試 → 預設 zh-Hant。
 * 回傳值必為 SUPPORTED_LOCALES 之一。
 */
export function resolveLocale(configLocale?: string): string {
  const explicit = normalizeLocale(configLocale);
  if (explicit) return explicit;

  // 自動偵測:navigator.languages 優先,退回 navigator.language
  try {
    const nav = typeof navigator !== "undefined" ? navigator : undefined;
    const candidates: string[] = [];
    if (nav) {
      if (Array.isArray(nav.languages)) candidates.push(...nav.languages);
      if (nav.language) candidates.push(nav.language);
    }
    for (const c of candidates) {
      const hit = normalizeLocale(c);
      if (hit) return hit;
    }
  } catch {
    /* 無 navigator(SSR / 測試)時忽略,走預設 */
  }
  return DEFAULT_LOCALE;
}

/** t 函式型別:依 key 取字串,可帶具名參數以 {name} 內插。 */
export type TranslateFn = (key: MessageKey, params?: Record<string, string | number>) => string;

/** 以 {name} 佔位符做具名內插;無對應參數者原樣保留。 */
function interpolate(tpl: string, params?: Record<string, string | number>): string {
  if (!params) return tpl;
  return tpl.replace(/\{(\w+)\}/g, (m, k: string) =>
    Object.prototype.hasOwnProperty.call(params, k) ? String(params[k]) : m,
  );
}

/**
 * 建立一個綁定於指定 locale 的 t 函式(instance-safe,不依賴模組全域狀態)。
 * 傳入的 locale 若非支援值會被正規化;仍無法對應則回退預設。缺 key 一律回退繁中。
 */
export function createTranslator(locale: string): TranslateFn {
  const resolved = normalizeLocale(locale) || DEFAULT_LOCALE;
  const dict = DICTIONARIES[resolved] || DICTIONARIES[DEFAULT_LOCALE];
  return (key, params) => {
    const s = dict[key] ?? DICTIONARIES[DEFAULT_LOCALE][key] ?? key;
    return interpolate(s, params);
  };
}

// ---- 模組層便利 API(單例情境用):setLocale + t + getLocale ----
let currentLocale = DEFAULT_LOCALE;
let currentT: TranslateFn = createTranslator(currentLocale);

/** 設定模組層目前 locale(供 t() 使用)。傳入值會經正規化。 */
export function setLocale(locale: string): void {
  currentLocale = normalizeLocale(locale) || DEFAULT_LOCALE;
  currentT = createTranslator(currentLocale);
}

/** 取得模組層目前 locale(正規化後)。 */
export function getLocale(): string {
  return currentLocale;
}

/** 模組層 t():依目前 setLocale 的語系取字串。多實例場景請改用 createTranslator。 */
export const t: TranslateFn = (key, params) => currentT(key, params);
