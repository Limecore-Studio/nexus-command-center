// The code email. Same look as limecore/email/confirm-signup-otp.html (the
// auth mails), cut down: wordmark, hairline, one card with the code in its
// well. English only, like every auth mail.
//
// `code` is always six digits (randomCode), so it is interpolated as-is; there
// is nothing else from outside in this message.

export function codeEmail(code: string): { subject: string; html: string; text: string } {
  const subject = 'Your Limecore code: ' + code;

  const text = [
    'Your Limecore code: ' + code,
    '',
    'Enter it in StudyDesk, under Settings > Support, to link this address to your account.',
    'Ko-fi payments from this address will then count for that account.',
    'The code is valid for 15 minutes.',
    '',
    "Didn't ask for this? Ignore this email. Nothing is linked without the code.",
    '',
    'limecore.dev',
  ].join('\n');

  const mono = "'Space Mono',ui-monospace,'SF Mono','Roboto Mono',Menlo,Consolas,monospace";
  const display = "'Oxanium','Segoe UI',-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<title>${subject}</title>
</head>
<body style="margin:0; padding:0; width:100%; background-color:#0A0A0A; color:#F5F5F5;">
  <div style="display:none; max-height:0; overflow:hidden; opacity:0;">Link this Ko-fi address to your Limecore account. Valid for 15 minutes.</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#0A0A0A;">
    <tr><td align="center" style="padding:48px 20px;">
      <table role="presentation" align="center" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:460px; margin:0 auto;">
        <tr><td style="padding:0 0 14px 0;">
          <span style="font-family:${display}; font-size:17px; font-weight:800; letter-spacing:0.02em; text-transform:uppercase; color:#F5F5F5;">Lime<span style="color:#A3E635;">core</span></span>
        </td></tr>
        <tr><td style="padding:0 0 36px 0; font-size:0; line-height:0;">
          <div style="height:1px; background-color:#1A1A1A; background-image:linear-gradient(90deg, rgba(163,230,53,0.9), rgba(163,230,53,0.15) 60%, rgba(163,230,53,0));">&nbsp;</div>
        </td></tr>
        <tr><td style="background-color:#111111; border:1px solid #1A1A1A; padding:38px 34px 34px 34px;">
          <p style="margin:0 0 18px 0; font-family:${mono}; font-size:10px; font-weight:700; letter-spacing:0.3em; text-transform:uppercase; color:#A3E635; line-height:14px;">Ko-fi email</p>
          <h1 style="margin:0 0 14px 0; font-family:${display}; font-size:27px; font-weight:800; letter-spacing:-0.02em; text-transform:uppercase; color:#F5F5F5; line-height:32px;">Confirm this address</h1>
          <p style="margin:0 0 30px 0; font-family:${mono}; font-size:13px; color:#737373; line-height:22px;">Enter this code in StudyDesk, under Settings &rsaquo; Support. Ko-fi payments from this address will then count for your account.</p>
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 26px 0;">
            <tr>
              <td width="3" style="width:3px; background-color:#A3E635; font-size:0; line-height:0;">&nbsp;</td>
              <td style="background-color:#0A0A0A; border:1px solid #1A1A1A; border-left:none; padding:26px 20px;" align="center">
                <span style="font-family:${mono}; font-size:36px; font-weight:700; letter-spacing:0.32em; text-indent:0.32em; color:#A3E635; line-height:44px; white-space:nowrap;">${code}</span>
              </td>
            </tr>
          </table>
          <p style="margin:0; font-family:${mono}; font-size:11px; letter-spacing:0.08em; text-transform:uppercase; color:#737373; line-height:16px;">Valid for 15 minutes</p>
        </td></tr>
        <tr><td style="padding:26px 2px 0 2px;">
          <p style="margin:0 0 22px 0; font-family:${mono}; font-size:11px; color:#5A5A5A; line-height:19px;">Didn't ask for this? Ignore this email &mdash; nothing is linked without the code above.</p>
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
            <tr><td style="border-top:1px solid #1A1A1A; padding:18px 0 0 0;">
              <p style="margin:0 0 5px 0; font-family:${mono}; font-size:10px; letter-spacing:0.2em; text-transform:uppercase; color:#5A5A5A;"><a href="https://limecore.dev" style="color:#5A5A5A; text-decoration:none;">limecore.dev</a></p>
              <p style="margin:0; font-family:${mono}; font-size:10px; letter-spacing:0.2em; text-transform:uppercase; color:#3A3A3A;">NCC &middot; LimeLog &middot; StudyDesk</p>
            </td></tr>
          </table>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return { subject, html, text };
}
