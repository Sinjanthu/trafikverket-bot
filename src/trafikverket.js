function setPath(obj, dotPath, value) {
  const keys = dotPath.split(".");
  let node = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (typeof node[keys[i]] !== "object" || node[keys[i]] === null) {
      node[keys[i]] = {};
    }
    node = node[keys[i]];
  }
  node[keys[keys.length - 1]] = value;
}

/**
 * Sends the exact request your browser sends (captured into payload.json),
 * once per configured city, swapping in that city's locationId.
 *
 * locationIdField supports dot paths for nested payloads, e.g.
 * "occasionBundleQuery.locationId" - not just top-level "locationId".
 */
export async function fetchOccasionsForCity(cfg, payloadTemplate, city) {
  const body = JSON.parse(JSON.stringify(payloadTemplate)); // deep clone, don't mutate the template

  setPath(body, cfg.locationIdField || "locationId", city.locationId);

  if (cfg.startDateField) {
    setPath(body, cfg.startDateField, new Date().toISOString());
  }

  const res = await fetch(cfg.apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Cookie: cfg.cookie,
      // Some Trafikverket endpoints reject requests without a browser-like UA.
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    },
    body: JSON.stringify(body),
  });

  if (res.status === 401 || res.status === 403) {
    throw new SessionExpiredError(
      `Got HTTP ${res.status} for "${city.name}". Your session cookie has probably expired - see README.md "Refreshing your session".`
    );
  }

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    // Trafikverket's actual expired-session response in the wild is
    // HTTP 400 with {"type":"LoginRequiredException"} in the body, not the
    // 401/403 checked above - without this, every poll after expiry logs a
    // separate generic error per city instead of one clear session-expired
    // notice, and the process never reports failure to the caller.
    if (bodyText.includes("LoginRequiredException")) {
      throw new SessionExpiredError(
        `Got HTTP ${res.status} (LoginRequiredException) for "${city.name}". Your session cookie has probably expired - see README.md "Refreshing your session".`
      );
    }
    throw new Error(`HTTP ${res.status} for "${city.name}": ${bodyText}`);
  }

  const json = await res.json();
  return { city, raw: json };
}

export class SessionExpiredError extends Error {}

/**
 * Trafikverket's response shape isn't publicly documented and can change.
 * This walks the JSON looking for objects that look like a bookable occasion
 * (something with a date/time and, usually, some kind of vehicle/transmission
 * info). If your notifications come back empty despite the site showing
 * slots, run with DEBUG=1 to dump the raw JSON and adjust the field names
 * below to match what you actually see.
 */
export function extractOccasions(raw) {
  const found = [];

  const dateKeys = ["date", "occasionDate", "startDate", "day"];
  const timeKeys = ["time", "startTime", "occasionTime"];
  const transmissionKeys = ["transmission", "gearType", "vehicleType", "gearboxType"];
  const locationNameKeys = ["locationName", "name", "examinationCenterName"];
  const priceKeys = ["price", "cost", "fee", "amount", "examinationFee"];

  function walk(node) {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === "object") {
      const keys = Object.keys(node);
      const hasDate = keys.find((k) => dateKeys.includes(k));
      const hasTime = keys.find((k) => timeKeys.includes(k));
      if (hasDate || hasTime) {
        const transmissionKey = keys.find((k) => transmissionKeys.includes(k));
        const locationKey = keys.find((k) => locationNameKeys.includes(k));
        const priceKey = keys.find((k) => priceKeys.includes(k));
        found.push({
          date: hasDate ? node[hasDate] : null,
          time: hasTime ? node[hasTime] : null,
          transmissionRaw: transmissionKey ? String(node[transmissionKey]) : null,
          locationName: locationKey ? node[locationKey] : null,
          price: priceKey ? node[priceKey] : null,
          _source: node,
        });
      }
      Object.values(node).forEach(walk);
    }
  }

  walk(raw);
  return found;
}

export function matchesTransmission(occasion, wanted) {
  if (wanted === "any") return true;
  if (!occasion.transmissionRaw) return true; // can't filter what we can't see - don't silently drop it
  const val = occasion.transmissionRaw.toLowerCase();
  const isAutomatic = val.includes("automat");
  const isManual = val.includes("manuell") || val.includes("manual");
  if (wanted === "automatic") return isAutomatic || (!isAutomatic && !isManual);
  if (wanted === "manual") return isManual;
  return true;
}
