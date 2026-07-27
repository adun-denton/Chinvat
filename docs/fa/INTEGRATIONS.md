<p align="center">
  <b>فارسی</b> &nbsp;·&nbsp; <a href="../MODULES.md">English</a>
</p>

<p align="center"><a href="README.md">فهرست راهنمای فارسی</a></p>

# پیکربندی سرویس‌ها

در صفحهٔ **Modules** فیلدها را وارد کنید، Module را Enable کنید، Tier را انتخاب و Save کنید، سپس **Test connection** و یک Operation واقعی کم‌خطر را اجرا کنید. Health سالم فقط Identity و Connectivity را ثابت می‌کند؛ Scope، Product، Credit و Write access باید جداگانه آزمایش شوند.

چینوات ۲۰ Module داخلی دارد. مرجع کامل Operationها در [Modules guide](../MODULES.md) است.

## Authentication و Remote Node

Hub محلی به‌طور پیش‌فرض روی `127.0.0.1` و بدون Token اجرا می‌شود. Bind خارج از Loopback بدون `authToken` خطای Startup است. Token باید حداقل ۲۴ کاراکتر باشد و `/mcp`، `/api` و `/ws` را محافظت می‌کند.

برای ماشین راه دور، Hub را به IP شبکهٔ خصوصی Tailscale/Headscale متصل کنید، نه `0.0.0.0`. Module `remote-node` هر ماشین را به‌صورت یک Hub مستقل با Policy، Approval، Job ledger و Artifactهای خودش نگه می‌دارد.

Operationهای اصلی: `nodes_list`، `node_health`، `node_workers`، `node_capabilities`، `node_invoke`، `node_invoke_privileged`، `node_job_status`، `node_job_result` و `node_job_cancel`.

برای کار طولانی یا کاری که ممکن است منتظر Approval بماند از `mode:"async"` استفاده کنید و Job id را نگه دارید. راهنمای کامل: [Remote Nodes](../REMOTE-NODES.md).

## Gmail و Mail Relay

Module `gmail` از OAuth2 installed-app استفاده می‌کند. Fieldهای اصلی `client_id`، `client_secret` و `refresh_token` هستند. Operationها:

- `send_mail`
- `poll_matching`
- `read_message`
- `list_drafts`
- `read_draft`
- `label_processed`

راهنمای OAuth: [Gmail setup](../../app-bridges/gmail/SETUP.md).

Module `chat-relay` وضعیت Repository را به Packet محدود تبدیل می‌کند، پاسخ Chatbot را بدون اجرا Import می‌کند، آن را در Worktree موقت Validate می‌کند و Apply روی Branch زنده را پشت Approval خطرناک نگه می‌دارد.

Operationهای Lifecycle شامل `relay_create`، `relay_dispatch`، `relay_import`، `relay_validate`، `relay_apply`، `relay_repair`، `relay_reject`، `relay_status` و `relay_list` هستند. خود `chat-relay` Network transport ندارد؛ برای مسیر Mail، Coordinator آن را با `gmail.send_mail` ترکیب می‌کند. طراحی: [Mail Relay](../DESIGN-mail-relay.md).

## WordPress و Chinvat WP Bridge

Module داخلی `wordpress` از Core REST برای Post، Page، Media، Taxonomy و Navigation استفاده می‌کند. Application Password مخصوص Chinvat بسازید.

Create مربوط به Post/Page به‌صورت Draft انجام می‌شود. Publish، Delete، Navigation update، Theme write و Scaffold عملیات Consequential هستند و باید در Tier `approve` باقی بمانند.

افزونهٔ اختیاری [Chinvat WP Bridge](../../wp-plugin/chinvat-bridge/README.md) قابلیت‌های ثابت و Guarded برای Theme، Options، RankMath، Plugin toggle، Global Styles و Template/Part ارائه می‌کند. `bridge_info` وضعیت Version، Toggleها، PHP lint و Capabilityها را گزارش می‌کند.

قبل از Styling، `bridge_db_state` را اجرا کنید. DB overrideهای Global Styles و Templateها در Runtime بر فایل Theme مقدم‌اند. Export/Snapshot آن‌ها به فایل و Git هنوز Roadmap است.

**هشدار:** `theme-write` امکان Remote Code Execution دارد. فقط Application Password محدود و Actor قابل اعتماد استفاده کنید.

## WooCommerce

Module جداگانهٔ `woocommerce` از `/wp-json/wc/v3` استفاده می‌کند و ۱۴۴ Operation ثابت دارد؛ Raw request ندارد.

Readها فوری‌اند. Catalog write معمولاً `act` است؛ عملیات مالی، Customer، Checkout، Configuration، Webhook، Batch، Publish و Delete از نوع `dangerous` هستند. Writeها `dry_run` دارند و حذف/Refund/Toolهای حساس Force و Confirmation اضافه می‌خواهند.

برای Production از HTTPS و کاربر دارای `manage_woocommerce` استفاده کنید. Module را در Tier `approve` نگه دارید.

## Blender

Module `blender` از Bridge پین‌شده روی Loopback TCP، معمولاً `127.0.0.1:9876`، استفاده می‌کند. Operationهای Read شامل `scene_info`، `object_info` و `viewport_snapshot` هستند. `execute_python` خطرناک است و هم `python_enabled` و هم Approval می‌خواهد.

راهنما: [Blender bridge](../../app-bridges/blender/README.md).

## Orca

Module `orca` یک Slicer از خانوادهٔ Orca را از طریق CLI اجرا می‌کند. Scope آن Profile و Slicing است، نه Printer control یا ویرایش Raw G-code.

برای Printer/Nozzle از Preset موجود استفاده کنید، Deltaها را Patch کنید و دوباره Slice/Inspect کنید. مسیرها باید Absolute باشند و Modelها در Project directory محدود می‌شوند.

طراحی: [Local-app bridge design](../DESIGN-local-app-bridges.md).

## GIMP

Module `gimp` با Plugin کاربر روی Loopback، معمولاً `127.0.0.1:9877`، کار می‌کند. Plugin دارای GPLv3 است و در Repository MIT vendored نشده است.

Operationهای Read شامل `gimp_info`، `image_metadata` و `snapshot` هستند. `execute_python` خطرناک است و Toggle و Approval می‌خواهد.

راهنما: [GIMP setup](../../app-bridges/gimp/SETUP.md).

## Rhino

Module `rhino` با Plugin Rhino MCP روی Loopback، معمولاً `127.0.0.1:1999`، کار می‌کند. در هر Session دستور `mcpstart` را اجرا کنید.

Operationهای Read شامل Summary، Object info و Viewport snapshot هستند. `execute_rhinoscript` خطرناک است و Toggle جداگانه می‌خواهد.

راهنما: [Rhino setup](../../app-bridges/rhino/SETUP.md).

## Coolify

Module `coolify` به API یک Coolify self-hosted متصل می‌شود. Token را Team-scoped و حداقلی بسازید؛ از `root` استفاده نکنید.

Inventory از نوع Read است. Deploy/Start/Restart/Validate معمولاً `act` و Stop/Cancel از نوع `dangerous` هستند.

## Messaging و Social

- `telegram`: ارسال پیام/فایل، دریافت Update و Approval button اختیاری.
- `whatsapp`: WhatsApp Business Cloud API؛ بیرون پنجرهٔ ۲۴ ساعته Template تأییدشده لازم است.
- `facebook`: Page id و Page access token؛ Delete خطرناک است.
- `instagram`: Business/Creator account متصل به Page و URL عمومی تصویر برای Publish.
- `linkedin`: OAuth با `w_member_social` و Author URN دقیق از `me`.
- `x`: OAuth user token؛ قابلیت Publish/Search به Access tier حساب وابسته است.

## مدل‌های Hosted و Local

- `ollama`: Local؛ `chat` و `generate` از `think`، `format` و `options` پشتیبانی می‌کنند.
- `openrouter`: `chat` و `private_chat`. مسیر Private فقط با `adapter_invoke` و `ephemeral:true`، Allowlist دقیق Model/Provider و افزودن `openrouter` به `ephemeralModules` کار می‌کند.
- `openai-compatible`: برای NVIDIA، Groq، Together، Azure، LM Studio، vLLM و Endpointهای مشابه.

برای NVIDIA، `Base URL` را `https://integrate.api.nvidia.com/v1` قرار دهید، Key خود NVIDIA را استفاده کنید و Model id را با `list_models` بررسی کنید.

نام Fieldهای UI، Moduleها، Operationها، Commandها، URLها و Code blockها عمداً به English و مطابق برنامه نگه داشته شده‌اند.
