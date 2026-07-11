<p align="center">
  <b>فارسی</b> &nbsp;·&nbsp; <a href="../CONFIGURATION.md">English</a>
</p>

<p align="center"><a href="README.md">فهرست راهنمای فارسی</a></p>

# رفع خطا

اگر Output در سرویس مقصد دیده نمی‌شود، صرفاً به Approved شدن Job اکتفا نکنید. در **Jobs** وضعیت نهایی و پیام Upstream را بخوانید؛ Approval فقط اجازهٔ تلاش می‌دهد.

- `401`: Credential گم‌شده، منقضی یا نادرست.
- `403`: Scope، Permission، App Review، Product یا Role لازم موجود نیست.
- `402`، `429` یا Provider message: Credit، Quota، Access tier یا Rate limit.
- `400` یا `404`: Phone number ID، Page ID، IG account ID، Model ID، Author URN یا Resource نادرست.
- Network error، Timeout یا `connection refused`: Endpoint در دسترس نیست یا `Base URL`/Port نادرست است.

چینوات همهٔ Failureها را خودکار دسته‌بندی نمی‌کند. `health()` میان `not configured`، `unreachable`، `invalid key (401/403)`، `endpoint error` و `reachable` تفکیک ایجاد می‌کند. Job وضعیت HTTP بالادستی و Body کوتاه و Secret-redacted را حفظ می‌کند؛ نگاشت بالا راهنمای تفسیر Signal است.

ترتیب بررسی:

1. **Test connection** در **Modules**.
2. یک Operation هویتی مانند `me`، `get_me` یا `key_info`.
3. یک درخواست حداقلی واقعی.
4. وضعیت نهایی در **Jobs**.
5. Scope، App Review، Credit، Access tier، Rate limit و Identifier در پنل Provider.
