<p align="center">
  <b>فارسی</b> &nbsp;·&nbsp; <a href="../../README.md">English</a>
</p>

# راهنمای فارسی چینوات

چینوات یک مدل هوش مصنوعی نیست؛ یک هاب محلی و فدره‌شوندهٔ MCP است. هماهنگ‌کننده‌هایی مانند Codex و Claude کار را برنامه‌ریزی می‌کنند و چینوات Workerها، Job پایدار، Approval انسانی، Artifact، Policy و نتیجه را مدیریت می‌کند.

## مسیر پیشنهادی

1. [راه‌اندازی سریع](QUICKSTART.md)
2. [کار با مدل‌ها](MODELS.md)
3. [پیکربندی سرویس‌ها](INTEGRATIONS.md)
4. [رفع خطا](TROUBLESHOOTING.md)
5. [ساختار کامل مستندات انگلیسی](../README.md)

## شکل فعلی سیستم

هر ماشین یک Hub کامل با Moduleها، Tierها، Approval queue و Job ledger خودش اجرا می‌کند. ماژول `remote-node` چند Hub را از طریق MCP و شبکهٔ خصوصی مانند Tailscale/Headscale به هم متصل می‌کند، بدون آن‌که Policy یا Ledger آن‌ها با هم ادغام شود. برای Bind خارج از Loopback، `authToken` اجباری است و Dashboard نیز Token را درخواست می‌کند. راهنمای کامل در [Remote Nodes](../REMOTE-NODES.md) است.

چینوات اکنون ۲۰ ماژول داخلی دارد:

- مدل‌ها: `ollama`، `openrouter`، `openai-compatible`
- سیستم و زیرساخت: `system`، `coolify`، `remote-node`
- برنامه‌های محلی: `blender`، `orca`، `gimp`، `rhino`
- انتشار و تجارت: `wordpress`، `woocommerce`
- پیام‌رسانی و شبکه‌های اجتماعی: `telegram`، `whatsapp`، `facebook`، `instagram`، `linkedin`، `x`
- Relay: `gmail` و `chat-relay`

## Mail Relay

`chat-relay` وضعیت Repository را به یک Packet محدود و قابل‌اعتبارسنجی تبدیل می‌کند، پاسخ Chatbot را بدون اجرا Import می‌کند، آن را در Worktree موقت Validate می‌کند و Apply روی Branch زنده را پشت Approval خطرناک نگه می‌دارد. `gmail` فقط Carrier جداگانهٔ مسیر Mail است؛ Clipboard و File نیز قابل استفاده‌اند. طراحی در [Mail Relay](../DESIGN-mail-relay.md) و راه‌اندازی Gmail در [Gmail setup](../../app-bridges/gmail/SETUP.md) آمده است.

## WordPress و برنامه‌های محلی

برای مدیریت پیشرفتهٔ WordPress، افزونهٔ اختیاری [Chinvat WP Bridge](../../wp-plugin/chinvat-bridge/README.md) نسخهٔ `0.4.3` هجده Ability و Handshake احرازهویت‌شده ارائه می‌کند. ماژول جداگانهٔ `woocommerce` یک سطح ثابت و Guarded برای مدیریت Store دارد.

Blender، GIMP و Rhino از Socket روی Loopback استفاده می‌کنند؛ Orca یک CLI پین‌شده را اجرا می‌کند و عمداً Printer control ندارد. Snapshotهای PNG به‌صورت Artifact برای Caller دارای Vision ذخیره می‌شوند؛ خود Chinvat Vision اجرا نمی‌کند. طراحی مشترک در [Local-app bridge design](../DESIGN-local-app-bridges.md) است.

نام فیلدهای UI، Moduleها، Operationها، Commandها، URLها و Code blockها عمداً به English و مطابق برنامه نگه داشته شده‌اند.
