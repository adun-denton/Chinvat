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

برای مدیریت پیشرفتهٔ WordPress، افزونهٔ اختیاری [Chinvat WP Bridge](../../wp-plugin/chinvat-bridge/README.md) نسخهٔ `0.4.2` هجده Ability برای Options، فایل‌های Theme، DB-layer مربوط به Global Styles و Site Editor templates، RankMath، Plugin management و ساخت Child theme سازگار با Block ارائه می‌کند. ماژول TypeScript `wordpress` نسخهٔ `0.4.0` علاوه بر ویرایش Page موجود، مدیریت Block Navigation و Media library، `featured_media` و Upload محدودشده از URL/Base64، نوزده Operation ثابت `bridge_*` شامل `bridge_info` را از مسیر Job و Policy چینوات اجرا می‌کند؛ توضیح و هشدارهای امنیتی در [پیکربندی سرویس‌ها](INTEGRATIONS.md#wordpress-و-chinvat-wp-bridge) آمده است.

نام فیلدهای UI، نام ماژول‌ها و Operationها، Commandها، URLها و Code blockها در این راهنما عمداً به English و عیناً مطابق برنامه نگه داشته شده‌اند.
