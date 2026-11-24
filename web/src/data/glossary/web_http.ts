import type { GlossaryEntry } from './types';

export const WEB_HTTP_TERMS: GlossaryEntry[] = [
  {
    id: 'http',
    term: 'HTTP',
    category: 'web_http',
    oneLiner_en: 'The language browsers and servers use to ask for and send back information.',
    oneLiner_zh: '浏览器与服务器之间请求和返回信息时使用的通信规则。',
    plainExplain_en:
      'Like ordering at a counter: you make a request ("one coffee, please") and get a response (the coffee, or a note saying it is sold out). Studio talks to the local VibeBaton server exactly this way.',
    plainExplain_zh:
      '就像在柜台点单：你提出请求（“来一杯咖啡”），然后得到回应（一杯咖啡，或者一张“已售罄”的纸条）。Studio 与本地 VibeBaton 服务器正是这样交流的。',
    proExplain_en:
      'HyperText Transfer Protocol, a stateless request/response protocol. A request has a method (GET, POST, PUT), a path, headers, and an optional body; the response has a status code, headers, and a body. Studio calls JSON endpoints under `/api/` on the local server.',
    proExplain_zh:
      'HTTP 即 HyperText Transfer Protocol（超文本传输协议），一种无状态的请求/响应协议。请求包含方法（GET、POST、PUT）、路径、请求头和可选的请求体；响应包含状态码、响应头和响应体。Studio 调用的是本地服务器 `/api/` 下的 JSON 接口。',
    related: ['https', 'request', 'response', 'status-code', 'endpoint'],
  },
  {
    id: 'rest',
    term: 'REST',
    category: 'web_http',
    oneLiner_en: 'A common style for designing web APIs around resources and standard HTTP methods.',
    oneLiner_zh: '一种常见的 Web API 设计风格，围绕“资源”和标准 HTTP 方法来组织接口。',
    plainExplain_en:
      'Think of a well-organized library: every book has a shelf address, and there are a few standard actions such as look up, add, and replace. A REST API gives each thing its own address and uses the same small set of actions everywhere, so it is predictable.',
    plainExplain_zh:
      '可以想象一座整理得井井有条的图书馆：每本书都有固定的书架地址，可做的事情也只有查阅、新增、替换等几种标准操作。REST API 给每样东西一个独立地址，并在各处使用同一组操作，因此用起来很好预测。',
    proExplain_en:
      'Representational State Transfer: resources are identified by URLs (for example `/api/runs/{id}`), read with GET, created or triggered with POST, and replaced with PUT, exchanging JSON representations. Errors are signalled with HTTP status codes plus a JSON `error` field, which is how the Studio client reports failures.',
    proExplain_zh:
      'REST 即 Representational State Transfer（表述性状态转移）：资源由 URL 标识（例如 `/api/runs/{id}`），用 GET 读取，用 POST 创建或触发，用 PUT 替换，双方交换 JSON 表述。错误通过 HTTP 状态码加 JSON 中的 `error` 字段表达，Studio 客户端也正是据此报告失败。',
    related: ['http', 'api', 'endpoint', 'json', 'url'],
  },
  {
    id: 'json',
    term: 'JSON',
    category: 'web_http',
    oneLiner_en: 'A plain-text format for structured data that browsers and servers can both read.',
    oneLiner_zh: '一种纯文本的结构化数据格式，浏览器和服务器都能读取。',
    plainExplain_en:
      'Think of a standardized packing slip: every box lists its labels and contents in the same layout, so any reader can unpack it without guessing. Studio and the local server exchange most of their data as JSON.',
    plainExplain_zh:
      '可以把它想成标准化的装箱单：每个箱子都用同样的格式写明标签和内容，任何一方拆开时都不必猜测。Studio 与本地服务器之间的大部分数据都以 JSON 交换。',
    proExplain_en:
      'JavaScript Object Notation: objects, arrays, strings, numbers, booleans, and null encoded as UTF-8 text. The VibeBaton server returns JSON for `/api/` responses, and the Studio client parses it into typed objects such as runs, tasks, and presets; failures arrive as a JSON `error` field.',
    proExplain_zh:
      'JSON 即 JavaScript Object Notation：用 UTF-8 文本表示对象、数组、字符串、数字、布尔值和 null。VibeBaton 服务器的 `/api/` 响应均为 JSON，Studio 客户端将其解析为运行记录、任务、预设等类型化对象；失败时则返回带 `error` 字段的 JSON。',
    related: ['http', 'api', 'response', 'body', 'javascript'],
  },
  {
    id: 'status-code',
    term: 'Status Code',
    category: 'web_http',
    oneLiner_en: 'A three-digit number in a response saying whether a request succeeded, failed, or needs another step.',
    oneLiner_zh: '响应中的三位数字，用来说明请求是成功、失败，还是还需要进一步处理。',
    plainExplain_en:
      'Like the colored stamp on a form: green means approved, yellow means check somewhere else, and red means something went wrong. The number gives the category at a glance, and the body explains the details.',
    plainExplain_zh:
      '就像表格上的彩色印章：绿色代表通过，黄色代表要去别处补一步，红色代表出了问题。数字让人一眼看出大致结果，具体原因则写在响应体里。',
    proExplain_en:
      'The first line of an HTTP response, for example 200 OK, 201 Created, 404 Not Found, or 500 Internal Server Error. VibeBaton clients treat 2xx as success and raise `ApiError` with the status and JSON message for 4xx and 5xx responses.',
    proExplain_zh:
      'HTTP 响应的首行，例如 200 OK、201 Created、404 Not Found 或 500 Internal Server Error。VibeBaton 客户端把 2xx 视为成功；遇到 4xx 和 5xx 时，会带着状态码和 JSON 中的错误信息抛出 `ApiError`。',
    related: ['http', '404', '500', 'response', 'api'],
  },
  {
    id: 'sse',
    term: 'SSE',
    category: 'web_http',
    oneLiner_en: 'A way for a server to keep sending one-way text updates to a browser over one HTTP connection.',
    oneLiner_zh: '服务器通过一条 HTTP 连接持续向浏览器单向推送文本更新的一种方式。',
    plainExplain_en:
      'Like a radio broadcast: the browser tunes in once, and the server keeps talking without being asked again each time. The connection stays open until either side ends it.',
    plainExplain_zh:
      '就像收听广播：浏览器只需接入一次，服务器便持续播报，不必每次重新询问。连接会一直保持，直到某一方主动结束。',
    proExplain_en:
      'Server-Sent Events: a response with `Content-Type: text/event-stream` carrying `data:` messages, with optional `id:` and `event:` fields; `EventSource` reconnects automatically. It suits one-way progress feeds, though the VibeBaton Studio currently refreshes run state through ordinary API calls.',
    proExplain_zh:
      'SSE 即 Server-Sent Events（服务器发送事件）：响应头为 `Content-Type: text/event-stream`，内容是按 `data:` 组织的事件消息，还可带 `id:` 与 `event:` 字段，`EventSource` 会自动重连。它适合单向进度推送；目前 VibeBaton Studio 仍通过普通 API 调用刷新运行状态。',
    related: ['http', 'websocket', 'streaming', 'response', 'server'],
  },
  {
    id: 'websocket',
    term: 'WebSocket',
    category: 'web_http',
    oneLiner_en: 'A two-way connection that lets a browser and server keep exchanging messages without a new request each time.',
    oneLiner_zh: '一种双向连接，让浏览器和服务器持续交换消息，而不必每次都重新发起请求。',
    plainExplain_en:
      'Like a phone call instead of mailing letters: once both sides connect, either can speak immediately and keep talking until someone hangs up.',
    plainExplain_zh:
      '就像打电话而不是寄信：双方接通后，任何一方都能立刻开口，并且可以一直交流到有人挂断为止。',
    proExplain_en:
      'An upgrade from HTTP (`Upgrade: websocket`) to a framed, full-duplex TCP connection with a small per-message header. It suits chat and live collaboration; a request/response dashboard such as VibeBaton uses plain HTTP unless a feature genuinely needs push updates.',
    proExplain_zh:
      '通过 HTTP 升级（`Upgrade: websocket`）得到的带帧全双工 TCP 连接，每条消息只有很小的头部开销。它适合聊天和实时协作；像 VibeBaton 这样以请求/响应为主的看板，除非某个功能确实需要服务端推送，否则仍使用普通 HTTP。',
    related: ['http', 'sse', 'server', 'client', 'latency'],
  },
  {
    id: 'cors',
    term: 'CORS',
    category: 'web_http',
    oneLiner_en: 'Browser rules that decide whether a page from one origin may call an API on another origin.',
    oneLiner_zh: '浏览器规则，决定来自某个源的页面是否可以调用另一个源的 API。',
    plainExplain_en:
      'Like a building that requires visitors from another company to be on an approved guest list: the browser first checks whether the destination server welcomes that origin, and blocks the response if it does not.',
    plainExplain_zh:
      '就像某栋大楼要求外公司访客必须出现在获准名单上：浏览器会先确认目标服务器是否欢迎这个来源，如果不欢迎，就拦下响应。',
    proExplain_en:
      'Cross-Origin Resource Sharing: the browser sends an `Origin` header and, for non-simple requests, a preflight `OPTIONS`; the server answers with `Access-Control-Allow-Origin` and related headers. Studio normally talks to the same localhost origin, so VibeBaton avoids cross-origin calls in regular use.',
    proExplain_zh:
      'CORS 即 Cross-Origin Resource Sharing（跨源资源共享）：浏览器会发送 `Origin` 请求头；对于非简单请求，还会先发 `OPTIONS` 预检，服务器用 `Access-Control-Allow-Origin` 等响应头作答。Studio 通常与服务器同属 localhost 源，因此 VibeBaton 日常使用中不会产生跨源调用。',
    related: ['browser', 'http', 'header', 'request', 'localhost'],
  },
  {
    id: 'localhost',
    term: 'localhost',
    category: 'web_http',
    oneLiner_en: 'The name a computer uses to reach services running on itself.',
    oneLiner_zh: '计算机用来访问自身所运行服务的名称。',
    plainExplain_en:
      'Like calling your own extension from your desk phone: the call never leaves the building. VibeBaton runs on your machine, so Studio opens it at a localhost address.',
    plainExplain_zh:
      '就像用办公桌上的电话拨打自己的分机：通话根本不会离开这栋楼。VibeBaton 运行在你的电脑上，因此 Studio 通过 localhost 地址打开它。',
    proExplain_en:
      'A hostname that resolves to the loopback addresses `127.0.0.1` (IPv4) and `::1` (IPv6), keeping traffic on the local machine. The Studio dev server and the VibeBaton API listen on localhost ports, and the desktop shell loads the UI from there.',
    proExplain_zh:
      '该主机名会解析到回环地址 `127.0.0.1`（IPv4）和 `::1`（IPv6），流量始终留在本机。Studio 开发服务器与 VibeBaton API 都监听 localhost 上的端口，桌面外壳也从那里加载界面。',
    related: ['server', 'port', 'url', 'http', 'dns'],
  },
  {
    id: 'port',
    term: 'Port',
    category: 'web_http',
    oneLiner_en: 'A numbered channel that identifies which service on a machine should receive a network connection.',
    oneLiner_zh: '带编号的通道，用来确定机器上哪个服务应当接收网络连接。',
    plainExplain_en:
      'Like an apartment number in a building: the address finds the building (the computer), and the number finds the right door (the service). Two programs cannot listen on the same port at the same time.',
    plainExplain_zh:
      '就像楼里的门牌号：地址找到大楼（计算机），号码找到正确的房门（服务）。两个程序不能同时监听同一个端口。',
    proExplain_en:
      'A 16-bit transport-layer identifier (0-65535) paired with an IP address; HTTP commonly uses 80 or 443, while local development often picks 7860 or similar. If VibeBaton cannot start because `EADDRINUSE` appears, another process already holds the port.',
    proExplain_zh:
      '与 IP 地址配对的 16 位传输层标识（0-65535）；HTTP 常用 80 或 443，本地开发则常选 7860 之类的端口。如果 VibeBaton 启动时报 `EADDRINUSE`，说明该端口已被其他进程占用。',
    related: ['localhost', 'eaddrinuse', 'server', 'url', 'proxy'],
  },
  {
    id: 'endpoint',
    term: 'Endpoint',
    category: 'web_http',
    oneLiner_en: 'A specific URL and HTTP method that an API exposes for one operation.',
    oneLiner_zh: 'API 为某一项操作对外提供的一个具体 URL 与 HTTP 方法组合。',
    plainExplain_en:
      'Like a service counter in an office: the building is the API, and each counter handles one kind of request. You have to go to the right counter with the right form.',
    plainExplain_zh:
      '就像办公楼里的服务窗口：整栋楼是 API，每个窗口只办理一类业务。你必须带对材料，找对窗口。',
    proExplain_en:
      'The combination of an HTTP method and path, such as `POST /api/runs` or `GET /api/runs/{id}`. VibeBaton groups its endpoints by resource under `/api/`, and each returns JSON or a typed error.',
    proExplain_zh:
      'HTTP 方法与路径的组合，例如 `POST /api/runs` 或 `GET /api/runs/{id}`。VibeBaton 在 `/api/` 下按资源组织接口，每个接口返回 JSON 或类型化的错误。',
    related: ['api', 'url', 'http', 'request', 'response'],
  },
  {
    id: 'api',
    term: 'API',
    category: 'web_http',
    oneLiner_en: 'A defined set of requests one program can make to another program.',
    oneLiner_zh: '一个程序可以向另一个程序发起的一组明确定义的请求。',
    plainExplain_en:
      'Like a restaurant menu: it lists what you can order and how to ask for it, while hiding what happens in the kitchen. Developers build on the menu instead of reimplementing the whole system.',
    plainExplain_zh:
      '就像餐厅的菜单：它列出能点什么、该怎么点，同时隐藏了后厨的运作细节。开发者基于菜单来构建功能，而不必重造整个系统。',
    proExplain_en:
      'Application Programming Interface: the stable contract of endpoints, request shapes, and response shapes. VibeBaton exposes a local HTTP/JSON API under `/api/` for runs, tasks, presets, CLI drivers, and configuration; Studio is one client of that contract.',
    proExplain_zh:
      'API 即 Application Programming Interface（应用程序编程接口）：由接口、请求结构和响应结构组成的稳定契约。VibeBaton 在 `/api/` 下提供本地 HTTP/JSON API，涵盖运行、任务、预设、CLI 驱动和配置；Studio 只是该契约的一个客户端。',
    related: ['endpoint', 'http', 'json', 'rest', 'client'],
  },
  {
    id: 'url',
    term: 'URL',
    category: 'web_http',
    oneLiner_en: 'The full address of something on the web, including protocol, host, path, and optional query.',
    oneLiner_zh: '网络中某个资源的完整地址，包括协议、主机、路径以及可选的查询参数。',
    plainExplain_en:
      'Like a complete postal address: country, city, street, apartment, plus a note such as "second floor". Every part has a fixed place and meaning.',
    plainExplain_zh:
      '就像完整的邮寄地址：国家、城市、街道、门牌，再附加一句“二楼”。每个部分的位置和含义都是固定的。',
    proExplain_en:
      'Uniform Resource Locator, for example `http://127.0.0.1:7860/api/runs?limit=20`: scheme, host, port, path, query string, and fragment. Studio builds API paths by joining the base URL with endpoint paths and escaping ids with `encodeURIComponent`.',
    proExplain_zh:
      'URL 即 Uniform Resource Locator（统一资源定位符），例如 `http://127.0.0.1:7860/api/runs?limit=20`，由协议、主机、端口、路径、查询字符串和片段组成。Studio 通过把基础 URL 与接口路径拼接，并用 `encodeURIComponent` 转义标识符来构造 API 地址。',
    related: ['http', 'endpoint', 'query-string', 'localhost', 'https'],
  },
  {
    id: 'query-string',
    term: 'Query String',
    category: 'web_http',
    oneLiner_en: 'The optional `?key=value` part of a URL that passes small parameters to the server.',
    oneLiner_zh: 'URL 中可选的 `?key=value` 部分，用来向服务器传递少量参数。',
    plainExplain_en:
      'Like a filter checklist attached to an order: "only today\'s runs, twenty at most". The address stays the same; the checklist changes what comes back.',
    plainExplain_zh:
      '就像订单上附带的筛选清单：“只要今天的运行，最多二十条”。地址不变，清单决定返回什么结果。',
    proExplain_en:
      'The section after `?` in a URL, made of `&`-separated name/value pairs whose values must be percent-encoded. VibeBaton uses it for options such as `?lang=zh` or `?limit=20`, and the server parses it before routing the request.',
    proExplain_zh:
      'URL 中 `?` 之后的部分，由用 `&` 分隔的键值对组成，其值必须做百分号编码。VibeBaton 用它传递 `?lang=zh` 或 `?limit=20` 之类的选项，服务器在路由请求之前先解析它。',
    related: ['url', 'request', 'get-request', 'api', 'endpoint'],
  },
  {
    id: 'request',
    term: 'Request',
    category: 'web_http',
    oneLiner_en: 'A message a client sends to a server asking it to do something.',
    oneLiner_zh: '客户端发送给服务器、请求其执行某项操作的消息。',
    plainExplain_en:
      'Like placing an order: it says what you want, which table you are at, and what you already know. The server reads it and decides how to answer.',
    plainExplain_zh:
      '就像点单：说明你要什么、你坐在哪一桌，以及你已经知道的信息。服务器读完这些内容，再决定如何回应。',
    proExplain_en:
      'An HTTP request carries a method, target URL, headers, and an optional body. Studio client methods such as `requestJson` assemble requests, attach JSON headers, and decode the response into typed results.',
    proExplain_zh:
      'HTTP 请求包含方法、目标 URL、请求头和可选的请求体。Studio 客户端的 `requestJson` 等方法负责组装请求、附加 JSON 请求头，并把响应解码成类型化结果。',
    related: ['response', 'http', 'get-request', 'post-request', 'header'],
  },
  {
    id: 'response',
    term: 'Response',
    category: 'web_http',
    oneLiner_en: 'The server message that answers a request, with a status, headers, and usually a body.',
    oneLiner_zh: '服务器用来回应请求的消息，包含状态、响应头，通常还有响应体。',
    plainExplain_en:
      'Like the reply at the counter: it tells you whether the order worked and hands you the result, or explains what went wrong.',
    plainExplain_zh:
      '就像柜台给出的答复：它会告诉你订单是否办成并交付结果，或者解释哪里出了问题。',
    proExplain_en:
      'An HTTP response begins with a status line, followed by headers and an optional body. VibeBaton endpoints return JSON on success and a JSON `error` with a 4xx or 5xx status on failure, which the client turns into `ApiError`.',
    proExplain_zh:
      'HTTP 响应以状态行开头，随后是响应头和可选的响应体。VibeBaton 的接口成功时返回 JSON，失败时返回带 4xx 或 5xx 状态的 JSON `error`，客户端会将其转换为 `ApiError`。',
    related: ['request', 'status-code', 'body', 'header', 'json'],
  },
  {
    id: 'header',
    term: 'Header',
    category: 'web_http',
    oneLiner_en: 'A named field in a request or response that carries metadata about the message.',
    oneLiner_zh: '请求或响应中带名称的字段，用来携带关于这条消息的元数据。',
    plainExplain_en:
      'Like the label on a parcel: it does not hold the contents, but it says what they are, where they came from, and how to handle them.',
    plainExplain_zh:
      '就像包裹上的标签：里面装的不是标签本身，但标签说明了内容物是什么、从哪里来、该怎么处理。',
    proExplain_en:
      'Case-insensitive `Name: value` pairs such as `Content-Type: application/json`, `Authorization: Bearer ...`, or `Cache-Control`. VibeBaton relies on `Content-Type` to parse JSON and lets the local server set CORS headers.',
    proExplain_zh:
      '不区分大小写的 `名称: 值` 键值对，例如 `Content-Type: application/json`、`Authorization: Bearer ...` 或 `Cache-Control`。VibeBaton 依赖 `Content-Type` 解析 JSON，并由本地服务器设置 CORS 响应头。',
    related: ['request', 'response', 'body', 'cors', 'api-key'],
  },
  {
    id: 'body',
    term: 'Body',
    category: 'web_http',
    oneLiner_en: 'The main content of an HTTP message, such as JSON data or a file.',
    oneLiner_zh: 'HTTP 消息的主体内容，例如 JSON 数据或文件。',
    plainExplain_en:
      'Like the contents of an envelope: the address is on the outside, and the actual letter is inside. A GET request usually has no body; a POST or PUT usually does.',
    plainExplain_zh:
      '就像信封里的内容：地址写在信封外面，真正的信纸在里面。GET 请求通常没有请求体，而 POST 或 PUT 通常带有请求体。',
    proExplain_en:
      'The payload after the headers, whose format is declared by `Content-Type`. VibeBaton sends request bodies as JSON for operations such as launching a run, and receives run records or error payloads the same way.',
    proExplain_zh:
      '响应或请求头之后的有效载荷，其格式由 `Content-Type` 声明。VibeBaton 在发起运行等操作时以 JSON 作为请求体，也同样以 JSON 接收运行记录或错误载荷。',
    related: ['request', 'response', 'json', 'header', 'post-request'],
  },
  {
    id: 'get-request',
    term: 'GET',
    category: 'web_http',
    oneLiner_en: 'The HTTP method for retrieving a resource without changing it.',
    oneLiner_zh: 'HTTP 方法，用于读取资源而不改变它。',
    plainExplain_en:
      'Like reading a page in a book: you only look, you do not write. Repeating the same read should return the same result and leave nothing changed.',
    plainExplain_zh:
      '就像翻看书中某一页：只是阅读，不会改写。重复同样的读取应当得到相同结果，也不会改变任何东西。',
    proExplain_en:
      'A safe, idempotent method whose parameters normally live in the query string, and which should not carry a request body. VibeBaton uses GET endpoints such as `/api/runs` and `/api/presets` to list or fetch data.',
    proExplain_zh:
      '安全且幂等的方法，参数通常放在查询字符串中，并且不应携带请求体。VibeBaton 使用 `GET /api/runs`、`GET /api/presets` 等接口列出或读取数据。',
    related: ['post-request', 'put-request', 'http', 'request', 'query-string'],
  },
  {
    id: 'post-request',
    term: 'POST',
    category: 'web_http',
    oneLiner_en: 'The HTTP method for sending data that creates something or triggers an action.',
    oneLiner_zh: 'HTTP 方法，用于发送数据以创建资源或触发某个动作。',
    plainExplain_en:
      'Like submitting a form at a counter: you hand over information and the clerk starts a process, often returning a ticket number.',
    plainExplain_zh:
      '就像在柜台递交表格：你交出信息，工作人员开始处理，通常还会给你一个受理编号。',
    proExplain_en:
      'A method that carries a request body and is generally not idempotent, so repeating it can create duplicate work. VibeBaton POSTs to `/api/runs` to launch a run and returns the new run id.',
    proExplain_zh:
      '该方法携带请求体，通常不具备幂等性，重复调用可能产生重复的工作。VibeBaton 通过 `POST /api/runs` 启动运行，并返回新的运行 ID。',
    related: ['get-request', 'put-request', 'http', 'body', 'request'],
  },
  {
    id: 'put-request',
    term: 'PUT',
    category: 'web_http',
    oneLiner_en: 'The HTTP method for replacing a resource with the version you send.',
    oneLiner_zh: 'HTTP 方法，用你发送的版本整体替换某个资源。',
    plainExplain_en:
      'Like replacing a whole form on a clipboard: whatever was there is swapped for the complete new version you provide.',
    plainExplain_zh:
      '就像把写字板上的整张表格换掉：原有的内容被你所提供的完整新版内容替换。',
    proExplain_en:
      'An idempotent method that replaces the target resource as a whole; PATCH is the usual alternative for partial updates. VibeBaton uses PUT for full-state updates such as the budget profile, custom pricing, and role configuration.',
    proExplain_zh:
      '幂等方法，会整体替换目标资源；部分更新通常改用 PATCH。VibeBaton 用 PUT 提交整体状态更新，例如预算档位、自定义价格和角色配置。',
    related: ['post-request', 'get-request', 'http', 'request', 'endpoint'],
  },
  {
    id: 'frontend',
    term: 'Frontend',
    category: 'web_http',
    oneLiner_en: 'The part of an application users see and interact with in the browser.',
    oneLiner_zh: '应用中用户能在浏览器里看到并与之交互的部分。',
    plainExplain_en:
      'Like the dining room of a restaurant: the menu, tables, and service are what guests experience, while the kitchen stays out of sight.',
    plainExplain_zh:
      '就像餐厅的前厅：菜单、桌椅和服务是客人直接体验到的部分，而后厨则在视线之外。',
    proExplain_en:
      'The client-side layer that renders UI and handles input, built here with React and TypeScript and bundled by Vite. The VibeBaton frontend runs in the browser and reaches the local server only through the `/api/` client.',
    proExplain_zh:
      '负责渲染界面、处理输入的客户端层，本项目用 React 和 TypeScript 编写，并由 Vite 打包。VibeBaton 前端在浏览器中运行，只通过 `/api/` 客户端访问本地服务器。',
    related: ['backend', 'browser', 'react', 'typescript', 'vite'],
  },
  {
    id: 'backend',
    term: 'Backend',
    category: 'web_http',
    oneLiner_en: 'The part of an application that runs on a server and does the real work behind the scenes.',
    oneLiner_zh: '应用在服务器上运行、在幕后完成实际工作的部分。',
    plainExplain_en:
      'Like the kitchen of a restaurant: it receives orders, prepares the food, and sends results back, while guests never enter it.',
    plainExplain_zh:
      '就像餐厅的后厨：接收订单、准备食物并送出成品，而客人从不踏进后厨。',
    proExplain_en:
      'The server-side process that owns data, files, and execution. The VibeBaton backend is the local Python service that spawns CLI drivers, tracks runs, and serves the HTTP/JSON API the frontend calls.',
    proExplain_zh:
      '掌管数据、文件与执行过程的服务器端进程。VibeBaton 后端是一个本地 Python 服务，负责启动 CLI 驱动、跟踪运行状态，并提供前端所调用的 HTTP/JSON API。',
    related: ['frontend', 'server', 'api', 'cli-driver', 'endpoint'],
  },
  {
    id: 'server',
    term: 'Server',
    category: 'web_http',
    oneLiner_en: 'A program that listens for requests and answers them with data or actions.',
    oneLiner_zh: '监听请求并用数据或操作来回应请求的程序。',
    plainExplain_en:
      'Like a help desk that stays open: it waits for questions, looks up the answer, and replies. Many clients can talk to one server at once.',
    plainExplain_zh:
      '就像一直有人值守的服务台：等待提问、查找答案并作出回复。多个客户端可以同时与同一个服务器交流。',
    proExplain_en:
      'A process bound to an address and port that accepts connections and responds. VibeBaton runs its server locally, so project files and API keys stay on your machine instead of a hosted service.',
    proExplain_zh:
      '绑定到某个地址和端口、接受连接并作出响应的进程。VibeBaton 的服务器运行在本机，因此项目文件和 API 密钥都留在你的电脑上，而不是交给托管服务。',
    related: ['client', 'backend', 'port', 'request', 'response'],
  },
  {
    id: 'client',
    term: 'Client',
    category: 'web_http',
    oneLiner_en: 'The program that sends requests to a server and uses its answers.',
    oneLiner_zh: '向服务器发送请求并使用其答复的程序。',
    plainExplain_en:
      'Like a customer at a help desk: it asks the questions and acts on the replies. The browser page is the client; the help desk is the server.',
    plainExplain_zh:
      '就像服务台前的访客：提出问题，并根据答复采取行动。浏览器页面是客户端，服务台是服务器。',
    proExplain_en:
      'The requesting side of a client/server exchange. `BatonApiClient` in Studio wraps `fetch`, adds JSON handling and timeouts, and turns non-2xx responses into `ApiError` instances.',
    proExplain_zh:
      '客户端/服务器交互中发起请求的一方。Studio 中的 `BatonApiClient` 封装了 `fetch`，负责 JSON 处理与超时控制，并把非 2xx 响应转换为 `ApiError` 实例。',
    related: ['server', 'request', 'response', 'api', 'browser'],
  },
  {
    id: 'browser',
    term: 'Browser',
    category: 'web_http',
    oneLiner_en: 'The application that loads web pages, runs their JavaScript, and displays the interface.',
    oneLiner_zh: '负责加载网页、运行其 JavaScript 并显示界面的应用程序。',
    plainExplain_en:
      'Like a universal player for websites: it fetches the page, runs its code in a sandbox, and shows the result while protecting the rest of your computer.',
    plainExplain_zh:
      '就像万能的网站播放器：取回页面、在沙箱中运行其代码并显示结果，同时保护电脑的其他部分。',
    proExplain_en:
      'A sandboxed runtime such as Chrome, Edge, Firefox, or Safari that executes HTML, CSS, and JavaScript and enforces the same-origin policy. Studio is a React app that runs in the browser and stores small preferences in `localStorage`.',
    proExplain_zh:
      'Chrome、Edge、Firefox、Safari 等沙箱化运行环境，负责执行 HTML、CSS 和 JavaScript，并执行同源策略。Studio 是运行在浏览器中的 React 应用，并把少量偏好设置保存在 `localStorage` 里。',
    related: ['frontend', 'dom', 'javascript', 'cookie', 'local-storage'],
  },
  {
    id: 'dom',
    term: 'DOM',
    category: 'web_http',
    oneLiner_en: 'The in-memory tree of elements a browser builds from an HTML page.',
    oneLiner_zh: '浏览器根据 HTML 页面构建出的内存元素树。',
    plainExplain_en:
      'Like a family tree of every heading, button, and paragraph on the page. JavaScript reads and changes the tree, and the browser redraws what changed.',
    plainExplain_zh:
      '就像页面上每个标题、按钮和段落的族谱。JavaScript 读取并修改这棵树，浏览器再重绘发生变化的部分。',
    proExplain_en:
      'The Document Object Model: a live tree of `Node` objects exposed as `document`. React avoids manual DOM edits by rendering components into a root node and reconciling changes through its virtual DOM.',
    proExplain_zh:
      'DOM 即 Document Object Model（文档对象模型）：以 `document` 暴露的活动 `Node` 对象树。React 不手工修改 DOM，而是把组件渲染到根节点，并通过虚拟 DOM 协调变更。',
    related: ['html', 'browser', 'javascript', 'css', 'react'],
  },
  {
    id: 'html',
    term: 'HTML',
    category: 'web_http',
    oneLiner_en: 'The markup language that describes the structure and meaning of a web page.',
    oneLiner_zh: '用来描述网页结构与含义的标记语言。',
    plainExplain_en:
      'Like the skeleton and labels of a document: it says which part is a heading, a paragraph, or a button, but not how it looks or behaves.',
    plainExplain_zh:
      '就像文档的骨架和标签：它说明哪部分是标题、段落或按钮，但不决定外观和行为。',
    proExplain_en:
      'HyperText Markup Language: nested elements with attributes that the browser parses into the DOM. The Vite build emits a single `index.html` entry, and React fills its root element with the application.',
    proExplain_zh:
      'HTML 即 HyperText Markup Language（超文本标记语言）：带属性的嵌套元素，由浏览器解析为 DOM。Vite 构建会输出一个 `index.html` 入口，React 再把应用渲染进它的根元素。',
    related: ['css', 'dom', 'browser', 'javascript', 'frontend'],
  },
  {
    id: 'css',
    term: 'CSS',
    category: 'web_http',
    oneLiner_en: 'The language that controls how HTML elements look and are laid out.',
    oneLiner_zh: '控制 HTML 元素外观与布局的语言。',
    plainExplain_en:
      'Like the paint, furniture, and lighting of a room: the walls are already there, and these choices decide how the space looks and feels.',
    plainExplain_zh:
      '就像房间里的油漆、家具和灯光：墙体已经就位，而这些选择决定空间的外观与感受。',
    proExplain_en:
      'Cascading Style Sheets: selectors and declarations, plus layout systems such as flexbox and grid. Studio styles its components with Tailwind utility classes and a small set of custom stylesheet tokens.',
    proExplain_zh:
      'CSS 即 Cascading Style Sheets（层叠样式表）：由选择器和声明组成，并提供 flexbox、grid 等布局系统。Studio 使用 Tailwind 工具类以及少量自定义样式令牌来设置组件外观。',
    related: ['html', 'dom', 'browser', 'frontend', 'javascript'],
  },
  {
    id: 'javascript',
    term: 'JavaScript',
    category: 'web_http',
    oneLiner_en: 'The programming language that runs interactive code in web browsers and on Node.js.',
    oneLiner_zh: '在浏览器和 Node.js 中运行交互代码的编程语言。',
    plainExplain_en:
      'Like the electricity that makes the page\'s switches and dials actually do something. HTML provides the parts, CSS their look, and JavaScript their behavior.',
    plainExplain_zh:
      '就像让页面上的开关和旋钮真正起作用的电力。HTML 提供部件，CSS 决定外观，JavaScript 则赋予它们行为。',
    proExplain_en:
      'A dynamically typed language standardized as ECMAScript, with event-loop concurrency and modules. The Studio frontend is written in TypeScript, which compiles to JavaScript and runs in the browser, while tests run under Node.js via Vitest.',
    proExplain_zh:
      '一种动态类型语言，以 ECMAScript 为规范，具有事件循环并发模型和模块系统。Studio 前端用 TypeScript 编写，编译成 JavaScript 后在浏览器中运行；测试则通过 Vitest 在 Node.js 中执行。',
    related: ['typescript', 'browser', 'dom', 'react', 'vite'],
  },
  {
    id: 'typescript',
    term: 'TypeScript',
    category: 'web_http',
    oneLiner_en: 'A typed superset of JavaScript that catches many mistakes before the code runs.',
    oneLiner_zh: 'JavaScript 的类型化超集，能在代码运行之前发现许多错误。',
    plainExplain_en:
      'Like a building inspector reviewing the plans before construction: it checks that the pieces fit together and flags mismatches early, then the finished code runs like ordinary JavaScript.',
    plainExplain_zh:
      '就像施工前的图纸审查：提前检查各部件是否匹配，并尽早指出不一致之处；通过检查的代码再像普通 JavaScript 一样运行。',
    proExplain_en:
      'JavaScript plus static types, interfaces, and generics, checked by `tsc` and erased at build time. Studio shared types such as `GlossaryEntry` and `RunListItem` keep API payloads and components aligned, and `npx tsc --noEmit` is part of the verification gate.',
    proExplain_zh:
      'TypeScript 是 JavaScript 加上静态类型、接口和泛型，由 `tsc` 检查，并在构建时擦除类型。Studio 的 `GlossaryEntry`、`RunListItem` 等共享类型让 API 载荷与组件保持一致，`npx tsc --noEmit` 也是验证门禁的一部分。',
    related: ['javascript', 'type-check', 'react', 'vite', 'interface'],
  },
  {
    id: 'react',
    term: 'React',
    category: 'web_http',
    oneLiner_en: 'A JavaScript library for building user interfaces from reusable components.',
    oneLiner_zh: '用可复用组件构建用户界面的 JavaScript 库。',
    plainExplain_en:
      'Like assembling a page from Lego bricks: each brick is a small, self-contained piece, and the page updates by swapping only the bricks that changed.',
    plainExplain_zh:
      '就像用乐高积木拼页面：每块积木都是小巧、独立的部件，页面更新时只替换发生变化的那几块。',
    proExplain_en:
      'A component library that renders a virtual DOM and reconciles it with the real DOM; state changes trigger re-renders. Studio is a React application with hooks-based components and a `createRoot` entry point.',
    proExplain_zh:
      '一个组件库：先渲染虚拟 DOM，再与真实 DOM 协调；状态变化会触发重新渲染。Studio 是基于 React 的应用，使用 hooks 组件，并以 `createRoot` 作为入口。',
    related: ['javascript', 'dom', 'typescript', 'frontend', 'vite'],
  },
  {
    id: 'vite',
    term: 'Vite',
    category: 'web_http',
    oneLiner_en: 'A fast frontend build tool and development server.',
    oneLiner_zh: '快速的前端构建工具与开发服务器。',
    plainExplain_en:
      'Like an express checkout lane: it serves files instantly during development and bundles them for production in one step, so you spend less time waiting.',
    plainExplain_zh:
      '就像快捷收银通道：开发时即时提供文件，生产构建时一步完成打包，让你少花时间等待。',
    proExplain_en:
      'A dev server that serves ES modules over native browser imports, plus a production bundler built on Rollup. The Studio frontend runs under Vite in development, and its config enables the React plugin and test setup.',
    proExplain_zh:
      'Vite 的开发服务器利用浏览器原生 ES 模块直接提供文件，生产构建则基于 Rollup。Studio 前端在开发时由 Vite 运行，其配置启用了 React 插件和测试环境。',
    related: ['react', 'typescript', 'frontend', 'build', 'browser'],
  },
  {
    id: 'cookie',
    term: 'Cookie',
    category: 'web_http',
    oneLiner_en: 'A small piece of data a website stores in the browser and sends back with later requests.',
    oneLiner_zh: '网站存放在浏览器中的一小段数据，后续请求会把它一并发送回去。',
    plainExplain_en:
      'Like a loyalty card the shop hands you: you show it on your next visit so the shop remembers your preferences. It is tied to one site, not to every shop in the mall.',
    plainExplain_zh:
      '就像商店发给你的会员卡：下次到访时出示，商店便能记起你的偏好。它只属于某一家店，而不是整座商场的所有店铺。',
    proExplain_en:
      'A name/value pair stored by the browser and sent in the `Cookie` header to matching domains, subject to `Domain`, `Path`, `Expires`, `Secure`, `HttpOnly`, and `SameSite` rules. Studio keeps lightweight preferences in `localStorage` instead of cookies, so no session cookie is required.',
    proExplain_zh:
      '由浏览器保存的键值对，会通过 `Cookie` 请求头发送给匹配的域名，并受 `Domain`、`Path`、`Expires`、`Secure`、`HttpOnly` 和 `SameSite` 规则约束。Studio 把轻量偏好放在 `localStorage` 而非 Cookie 中，因此不需要会话 Cookie。',
    related: ['browser', 'local-storage', 'header', 'https', 'request'],
  },
  {
    id: 'local-storage',
    term: 'localStorage',
    category: 'web_http',
    oneLiner_en: 'A browser storage area that keeps small string key/value pairs across page visits.',
    oneLiner_zh: '浏览器存储区域，可跨页面访问保留小型字符串键值对。',
    plainExplain_en:
      'Like a notebook the browser keeps for one website: notes survive closing the tab, and the site can read them the next time it opens.',
    plainExplain_zh:
      '就像浏览器为某个网站保留的笔记本：记下的内容在关闭标签页后仍然存在，网站下次打开时可以重新读取。',
    proExplain_en:
      'A synchronous per-origin `Storage` map holding strings, usually limited to a few megabytes and never sent with requests. Studio uses it for UI preferences such as the studio mode, theme, sound settings, and recently imported cases.',
    proExplain_zh:
      '按源隔离的同步 `Storage` 映射，只能存字符串，容量通常为几兆，且不会随请求发送。Studio 用它保存界面偏好，例如引导/专业模式、主题、声音设置和最近导入的案例。',
    related: ['browser', 'cookie', 'javascript', 'frontend', 'dom'],
  },
  {
    id: 'https',
    term: 'HTTPS',
    category: 'web_http',
    oneLiner_en: 'HTTP carried over an encrypted connection so others cannot read or alter the traffic.',
    oneLiner_zh: '通过加密连接传输的 HTTP，使他人无法读取或篡改流量。',
    plainExplain_en:
      'Like sending a letter in a sealed, tamper-evident envelope instead of a postcard: the address is still visible, but the contents are protected in transit.',
    plainExplain_zh:
      '就像用密封、可验损的信封寄信，而不是寄明信片：地址仍然可见，但内容在传输途中受到保护。',
    proExplain_en:
      'HTTP over TLS, defaulting to port 443, which authenticates the server certificate and encrypts the connection. VibeBaton talks to its local server over plain HTTP on loopback, while external provider APIs are called over HTTPS.',
    proExplain_zh:
      'HTTPS 即运行在 TLS 之上的 HTTP，默认使用 443 端口，通过服务器证书完成身份验证并加密连接。VibeBaton 与本机服务器之间在回环地址上使用普通 HTTP，而调用外部模型提供方 API 时使用 HTTPS。',
    related: ['http', 'url', 'server', 'browser', 'dns'],
  },
  {
    id: 'dns',
    term: 'DNS',
    category: 'web_http',
    oneLiner_en: 'The internet lookup service that turns a name like example.com into an IP address.',
    oneLiner_zh: '互联网的查询服务，把 example.com 这样的名称转换为 IP 地址。',
    plainExplain_en:
      'Like a phone book for the internet: you know the name, but the network needs the number to place the call. The lookup is usually quick and cached.',
    plainExplain_zh:
      '就像互联网的电话簿：你知道名字，但网络需要号码才能接通。查询通常很快，而且结果会被缓存。',
    proExplain_en:
      'The Domain Name System: hierarchical, cached records (A, AAAA, CNAME, MX, TXT) resolved through your configured resolver. Local addresses such as `localhost` bypass the network and resolve to loopback directly.',
    proExplain_zh:
      'DNS 即 Domain Name System（域名系统）：通过配置的解析器查询分层的缓存记录（A、AAAA、CNAME、MX、TXT 等）。`localhost` 之类的本地地址不经过网络，直接解析到回环地址。',
    related: ['url', 'https', 'localhost', 'proxy', 'latency'],
  },
  {
    id: 'proxy',
    term: 'Proxy',
    category: 'web_http',
    oneLiner_en: 'An intermediary that forwards requests between a client and another server.',
    oneLiner_zh: '在客户端与另一个服务器之间转发请求的中间层。',
    plainExplain_en:
      'Like a receptionist who takes your call and passes it on: the other side talks to the receptionist, and you get the answer without dealing with them directly.',
    plainExplain_zh:
      '就像前台接待替你接电话并转达：对方与接待沟通，你不必直接面对他们也能得到答复。',
    proExplain_en:
      'A forward proxy acts for clients; a reverse proxy fronts servers. Development setups often use a Vite proxy to forward `/api/` to the local backend, avoiding cross-origin requests while keeping one browser origin.',
    proExplain_zh:
      '正向代理代表客户端，反向代理则位于服务器前面。开发环境常用 Vite 代理把 `/api/` 转发到本地后端，从而避免跨源请求，同时保持浏览器只用同一个源。',
    related: ['server', 'client', 'cors', 'http', 'localhost'],
  },
  {
    id: 'latency',
    term: 'Latency',
    category: 'web_http',
    oneLiner_en: 'The time a request takes to travel to a server and for the response to come back.',
    oneLiner_zh: '请求发送到服务器并收到响应所经历的时间。',
    plainExplain_en:
      'Like the wait between placing an order and hearing "order ready": the work may be quick, but the trip and the queue add time. Lower latency makes an interface feel immediate.',
    plainExplain_zh:
      '就像点单后等待“出餐”的时间：真正的制作可能很快，但往返和排队会占用时间。延迟越低，界面感觉越即时。',
    proExplain_en:
      'Round-trip delay measured in milliseconds, combining propagation, queuing, and processing time. Model calls dominate VibeBaton run latency, so the UI shows live status instead of blocking; local API calls finish far faster.',
    proExplain_zh:
      '以毫秒计量的往返延迟，由传播、排队和处理时间共同构成。VibeBaton 的运行延迟主要来自模型调用，因此界面显示实时状态而不是一直阻塞等待；本地 API 调用则快得多。',
    related: ['http', 'server', 'timeout', 'sse', 'proxy'],
  },
];
