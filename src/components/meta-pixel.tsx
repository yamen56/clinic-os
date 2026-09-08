import Script from "next/script";

/**
 * Meta's tracking pixel, for the one page on this domain that sells software.
 *
 * This app is otherwise deliberately free of third-party tags — the CSP comment
 * in next.config says "there is no analytics tag and no CDN" and treats `'self'`
 * as the true answer rather than a compromise. That is not squeamishness about
 * marketing. `app.clinicti.app` serves the workspace where patient records live,
 * and a `connect-src` that reaches Meta is an exfiltration channel for any XSS
 * that ever gets in, which is precisely the thing the rest of the CSP exists to
 * close.
 *
 * So the pixel is confined twice over, and both fences are load-bearing:
 *
 *   1. **Where it renders.** The booking page mounts this only for a workspace
 *      whose vocabulary is `agency` — Clinicti's own demo booking, a B2B lead
 *      form. The other seven booking links belong to real clinics, and a Meta
 *      pixel on a page where somebody picks "dermatology" and types their phone
 *      number is how hospitals elsewhere have ended up in court. Jordan's PDPL
 *      treats health data as sensitive and this would be transferring it to a
 *      third-party processor, abroad, without a lawful basis anybody has
 *      established.
 *
 *   2. **Where the CSP allows it.** next.config grants the Facebook origins on
 *      exactly one path. Even if this component were mounted somewhere it should
 *      not be, the browser would refuse to load the script.
 *
 * Neither fence is sufficient alone, which is why there are two: the first is a
 * condition somebody could edit without noticing what it protects, and the
 * second is a path that has to be kept in step with the first.
 */
/**
 * Clinicti's own pixel, in the source rather than the environment.
 *
 * A pixel id is not a secret — it ships in the HTML of every page that uses it
 * and Meta's own install instructions are a copy-paste snippet containing it. So
 * the only thing an environment variable would add here is a way for this to be
 * deployed and silently do nothing, which is the failure mode hardest to notice
 * on a page whose whole job is to be measured. Same reasoning as
 * `CLINICTI_TERMS_URL` in components/powered-by.
 *
 * `META_PIXEL_ID` still overrides it, for a staging pixel or a rotation.
 */
export const CLINICTI_META_PIXEL_ID = "1371362911862828";

export function MetaPixel({ id }: { id: string }) {
  /*
    The id is interpolated into inline script, so it is checked rather than
    trusted. It comes from an environment variable today and that is exactly the
    kind of thing that later comes from a settings form; a digits-only guard
    costs nothing now and closes the injection before it can be introduced.
  */
  if (!/^\d{5,20}$/.test(id)) return null;

  return (
    <>
      <Script id="meta-pixel" strategy="afterInteractive">
        {`!function(f,b,e,v,n,t,s)
{if(f.fbq)return;n=f.fbq=function(){n.callMethod?
n.callMethod.apply(n,arguments):n.queue.push(arguments)};
if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
n.queue=[];t=b.createElement(e);t.async=!0;
t.src=v;s=b.getElementsByTagName(e)[0];
s.parentNode.insertBefore(t,s)}(window, document,'script',
'https://connect.facebook.net/en_US/fbevents.js');
fbq('init', '${id}');
fbq('track', 'PageView');`}
      </Script>
      <noscript>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          height="1"
          width="1"
          style={{ display: "none" }}
          alt=""
          src={`https://www.facebook.com/tr?id=${id}&ev=PageView&noscript=1`}
        />
      </noscript>
    </>
  );
}
