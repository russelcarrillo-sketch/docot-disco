// Función de Vercel: crea el pago de Mercado Pago de forma segura.
// Valida los precios reales desde Firestore (el cliente no puede alterarlos),
// calcula el envío según la configuración del admin y guarda el pedido.

const PROJECT = 'peces-disco';
const API_KEY = 'AIzaSyA0C0UR6-R4S_Cp86yEEfj1COLkY5oFPn4';
const FS_BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

function parseFs(v) {
  if (v == null) return null;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.integerValue !== undefined) return parseInt(v.integerValue, 10);
  if (v.doubleValue !== undefined) return parseFloat(v.doubleValue);
  if (v.booleanValue !== undefined) return v.booleanValue;
  if (v.nullValue !== undefined) return null;
  if (v.arrayValue) return (v.arrayValue.values || []).map(parseFs);
  if (v.mapValue) {
    const r = {};
    const f = v.mapValue.fields || {};
    Object.keys(f).forEach((k) => { r[k] = parseFs(f[k]); });
    return r;
  }
  return null;
}

function fsv(v) {
  if (typeof v === 'number') {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  return { stringValue: String(v == null ? '' : v) };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método no permitido' });
    return;
  }
  const token = process.env.MP_ACCESS_TOKEN;
  if (!token) {
    res.status(500).json({ error: 'Falta configurar MP_ACCESS_TOKEN en Vercel' });
    return;
  }
  try {
    const { items, envio } = req.body || {};
    if (!Array.isArray(items) || !items.length) {
      res.status(400).json({ error: 'El carrito está vacío' });
      return;
    }
    const requeridos = ['nombre', 'telefono', 'direccion', 'colonia', 'ciudad', 'estado', 'cp'];
    for (const c of requeridos) {
      if (!envio || !String(envio[c] || '').trim()) {
        res.status(400).json({ error: 'Faltan datos de envío' });
        return;
      }
    }

    // Precios y configuración de envío reales desde Firestore
    const fsRes = await fetch(`${FS_BASE}/negocio/hygger?key=${API_KEY}`);
    const fsData = await fsRes.json();
    if (!fsData.fields) throw new Error('No se pudo leer el catálogo');
    const hyg = {};
    Object.keys(fsData.fields).forEach((k) => { hyg[k] = parseFs(fsData.fields[k]); });
    const prods = hyg.productos || [];

    let subtotal = 0;
    const mpItems = [];
    const detalle = [];
    for (const it of items) {
      const p = prods.find((x) => x.id === it.id);
      const v = p && (p.variantes || [])[it.varIdx];
      const qty = Math.max(1, Math.min(20, parseInt(it.cantidad, 10) || 1));
      if (!p || !v || !(v.precio > 0)) {
        res.status(400).json({ error: 'Un producto del carrito ya no está disponible. Recarga la página.' });
        return;
      }
      subtotal += v.precio * qty;
      const titulo = `${p.nombre}${v.desc ? ' — ' + v.desc : ''}`.slice(0, 120);
      mpItems.push({ title: titulo, quantity: qty, unit_price: Number(v.precio), currency_id: 'MXN' });
      detalle.push({ nombre: titulo, cantidad: qty, precio: Number(v.precio) });
    }

    const envioCosto = Number(hyg.envioCosto) || 0;
    const envioGratisDesde = Number(hyg.envioGratisDesde) || 0;
    const costoEnvio = envioGratisDesde > 0 && subtotal >= envioGratisDesde ? 0 : envioCosto;
    if (costoEnvio > 0) {
      mpItems.push({ title: 'Envío', quantity: 1, unit_price: costoEnvio, currency_id: 'MXN' });
    }
    const total = subtotal + costoEnvio;

    // Guardar el pedido (colección "pedidos", solo-crear)
    const orderId = 'PED-' + Date.now().toString(36).toUpperCase();
    const orderFields = {
      fecha: fsv(new Date().toISOString()),
      status: fsv('pendiente_pago'),
      nombre: fsv(envio.nombre),
      telefono: fsv(envio.telefono),
      correo: fsv(envio.correo || ''),
      direccion: fsv(envio.direccion),
      colonia: fsv(envio.colonia),
      ciudad: fsv(envio.ciudad),
      estado: fsv(envio.estado),
      cp: fsv(envio.cp),
      referencias: fsv(envio.referencias || ''),
      items: fsv(JSON.stringify(detalle)),
      subtotal: fsv(subtotal),
      envio: fsv(costoEnvio),
      total: fsv(total),
    };
    await fetch(`${FS_BASE}/pedidos?documentId=${orderId}&key=${API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: orderFields }),
    });

    // Crear preferencia de Mercado Pago
    const base = `https://${req.headers.host}`;
    const prefRes = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: mpItems,
        external_reference: orderId,
        payer: { name: envio.nombre, email: envio.correo || undefined },
        back_urls: {
          success: `${base}/catalogo.html?pago=exito&pedido=${orderId}`,
          pending: `${base}/catalogo.html?pago=pendiente&pedido=${orderId}`,
          failure: `${base}/catalogo.html?pago=error`,
        },
        auto_return: 'approved',
        statement_descriptor: 'DOCTORDISCO',
      }),
    });
    const pref = await prefRes.json();
    if (!pref.init_point) {
      res.status(500).json({ error: 'Mercado Pago: ' + (pref.message || 'no se pudo crear el pago') });
      return;
    }
    res.status(200).json({ url: pref.init_point, pedido: orderId, total });
  } catch (e) {
    res.status(500).json({ error: 'Error interno: ' + e.message });
  }
}
