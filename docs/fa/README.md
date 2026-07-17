<p align="center">
  <b>فارسی</b> &nbsp;·&nbsp; <a href="../../README.md">English</a>
</p>

# راهنمای فارسی چینوات

چینوات یک مدل هوش مصنوعی نیست؛ یک هاب محلی MCP است که هماهنگ‌کننده‌هایی مانند Codex و Claude را به مدل‌ها، ویندوز، پیام‌رسان‌ها و سرویس‌های انتشار متصل می‌کند. هماهنگ‌کننده کار را برنامه‌ریزی می‌کند و چینوات اجرای Job، صف، تأیید انسانی، Artifact و نتیجه را مدیریت می‌کند.

## مسیر پیشنهادی

1. [راه‌اندازی سریع](QUICKSTART.md)
2. [کار با مدل‌ها](MODELS.md)
3. [پیکربندی سرویس‌ها](INTEGRATIONS.md)
4. [رفع خطا](TROUBLESHOOTING.md)

برای مدیریت پیشرفتهٔ WordPress، افزونهٔ اختیاری [Chinvat WP Bridge](../../wp-plugin/chinvat-bridge/README.md) نسخهٔ `0.4.3` هجده Ability برای Options، فایل‌های Theme، DB-layer مربوط به Global Styles و Site Editor templates، RankMath، Plugin management و ساخت Child theme سازگار با Block ارائه می‌کند. این نسخه PHP ورودی Agent را داخل Runtime با Zend parser بررسی می‌کند و در میزبان‌هایی که `proc_open` غیرفعال است نیز Fail closed باقی می‌ماند. ماژول TypeScript `wordpress` نسخهٔ `0.4.0` نوزده Operation ثابت `bridge_*` شامل `bridge_info` را از مسیر Job و Policy چینوات اجرا می‌کند؛ توضیح و هشدارهای امنیتی در [پیکربندی سرویس‌ها](INTEGRATIONS.md#wordpress-و-chinvat-wp-bridge) آمده است.

## برنامه‌های محلی: Blender، Orca، GIMP و Rhino

چهار ماژول داخلی `blender`، `orca`، `gimp` و `rhino` برنامه‌های محلی را کنترل می‌کنند. Blender، GIMP و Rhino از Socket روی Loopback استفاده می‌کنند؛ Orca یک CLI را اجرا می‌کند و عمداً هیچ Printer control ندارد. راه‌اندازی Rhino در [Rhino setup](../../app-bridges/rhino/SETUP.md) آمده است. ماژول `coolify` نیز زیرساخت سرور (Coolify self-hosted) را از طریق API مدیریت می‌کند. Snapshotهای PNG از نوع `read` به‌صورت Artifact ذخیره می‌شوند تا Caller دارای Vision آن‌ها را ببیند و Iteration انجام دهد؛ خود Chinvat Vision اجرا نمی‌کند. طراحی مشترک در [Local-app bridge design](../DESIGN-local-app-bridges.md)، راه‌اندازی Blender در [Blender bridge](../../app-bridges/blender/README.md) و راه‌اندازی GIMP در [GIMP setup](../../app-bridges/gimp/SETUP.md) است. جزئیات Operationها، Config و هشدار امنیتی در [پیکربندی سرویس‌ها](INTEGRATIONS.md#blender--صحنههای-سه‌بعدی-محلی) آمده است.

نام فیلدهای UI، نام ماژول‌ها و Operationها، Commandها، URLها و Code blockها در این راهنما عمداً به English و عیناً مطابق برنامه نگه داشته شده‌اند.
