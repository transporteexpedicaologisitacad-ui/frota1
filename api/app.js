import { neon } from '@neondatabase/serverless';
import crypto from 'node:crypto';

const sql = neon(process.env.DATABASE_URL);
const SECRET = process.env.AUTH_SECRET || crypto.createHash('sha256').update(String(process.env.DATABASE_URL)).digest('hex');
const sign = p => crypto.createHmac('sha256', SECRET).update(p).digest('base64url');
const eq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const bad = (res, m, c = 400) => res.status(c).json({ error: m });

// Confere o token e busca o perfil no banco a cada pedido (usuário bloqueado perde o acesso na hora)
async function who(req) {
  const t = String(req.headers.authorization || '').slice(7), [p, s] = t.split('.');
  if (!p || !s || !eq(sign(p), s)) return null;
  let d; try { d = JSON.parse(Buffer.from(p, 'base64url').toString()); } catch { return null; }
  if (!(d.exp > Date.now())) return null;
  const r = await sql`SELECT u.id, u.usuario, u.papel, u.transportadora_id AS t, tr.nome AS transp,
    (u.senha_hash = crypt('Admin123', u.senha_hash)) AS padrao
    FROM usuarios u JOIN transportadoras tr ON tr.id = u.transportadora_id
    WHERE u.id = ${d.uid} AND u.ativo AND tr.ativa`;
  return r[0] || null;
}

async function dados(t, master, uid) {
  const [cargas, clientes, motoristas, veiculos, regioes] = await sql.transaction([
    sql`SELECT c.id, c.embarcador, to_char(c.data_carregamento,'YYYY-MM-DD') AS data, c.destino, c.veiculo_id, c.motorista_id,
      c.condutor, c.numero_carga AS numero, c.frete::float8 AS frete, c.status_pagamento AS "pagFrete", (SELECT u.usuario FROM usuarios u WHERE u.id = c.usuario_id) AS lancado_por,
      COALESCE((SELECT json_agg(json_build_object('nf',n.numero,'cliente',n.cliente,'valor',n.valor::float8,'status',n.status) ORDER BY n.id) FROM notas_fiscais n WHERE n.carga_id = c.id), '[]'::json) AS notas,
      COALESCE((SELECT json_agg(json_build_object('tipo',d.tipo,'valor',d.valor::float8,'reemb',d.reembolso) ORDER BY d.id) FROM despesas d WHERE d.carga_id = c.id), '[]'::json) AS despesas
      FROM cargas c WHERE c.transportadora_id = ${t} AND (${master}::boolean OR c.usuario_id = ${uid}) ORDER BY c.data_carregamento DESC, c.id DESC`,
    sql`SELECT id, razao_social AS razao, nome_fantasia AS fantasia, CASE WHEN ${master}::boolean THEN cnpj END AS cnpj, CASE WHEN ${master}::boolean THEN endereco END AS endereco, CASE WHEN ${master}::boolean THEN contato END AS contato FROM clientes WHERE transportadora_id = ${t} ORDER BY id`,
    sql`SELECT id, nome, cnh, categoria AS cat FROM motoristas WHERE transportadora_id = ${t} AND ${master}::boolean ORDER BY id`,
    sql`SELECT id, perfil, placa FROM veiculos WHERE transportadora_id = ${t} ORDER BY id`,
    sql`SELECT id, nome FROM regioes WHERE transportadora_id = ${t} ORDER BY nome`,
  ]);
  const out = { cargas, clientes, motoristas, veiculos, regioes, usuarios: [] };
  if (master) out.usuarios = await sql`SELECT id, usuario, CASE WHEN ativo THEN 'Sim' ELSE 'Não' END AS ativo FROM usuarios WHERE transportadora_id = ${t} AND papel = 'usuario' ORDER BY id`;
  return out;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return bad(res, 'metodo', 405);
  try {
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});

    if (b.op === 'login') {
      const r = await sql`SELECT u.id FROM usuarios u JOIN transportadoras tr ON tr.id = u.transportadora_id
        WHERE lower(u.usuario) = lower(${String(b.user || '')}) AND u.senha_hash = crypt(${String(b.pass || '')}, u.senha_hash) AND u.ativo AND tr.ativa`;
      if (!r[0]) { await new Promise(x => setTimeout(x, 700)); return bad(res, 'login', 401); }
      const p = Buffer.from(JSON.stringify({ uid: r[0].id, exp: Date.now() + 12 * 36e5 })).toString('base64url');
      return res.status(200).json({ token: p + '.' + sign(p) });
    }

    const me = await who(req);
    if (!me) return bad(res, 'auth', 401);
    const master = me.papel === 'master', t = me.t;
    const ok = () => res.status(200).json({ ok: 1 });

    switch (b.op) {
      case 'load':
        return res.status(200).json({ eu: { usuario: me.usuario, papel: me.papel, transp: me.transp, padrao: me.padrao }, dados: await dados(t, master, me.id) });

      case 'save_carga': {
        const c = b.carga || {};
        if (!String(c.embarcador || '').trim() || !c.data) return bad(res, 'Informe o embarcador e a data.');
        const cond = String(c.condutor || '').trim().slice(0, 120);
        if (!cond) return bad(res, 'Informe o condutor.');
        const vid = +c.veiculo_id || null, mid = master ? (+c.motorista_id || null) : null;
        const ch = await sql`SELECT (SELECT count(*) FROM veiculos WHERE id = ${vid} AND transportadora_id = ${t})::int AS v,
          (SELECT count(*) FROM motoristas WHERE id = ${mid} AND transportadora_id = ${t})::int AS m`;
        const V = ch[0].v ? vid : null, M = ch[0].m ? mid : null;
        const nf = JSON.stringify((c.notas || []).map(n => ({ numero: String(n.nf || ''), cliente: String(n.cliente || ''), valor: +n.valor || 0, status: n.status })));
        const dp = JSON.stringify((c.despesas || []).map(d => ({ tipo: d.tipo, valor: +d.valor || 0, reembolso: d.reemb })));
        let id = +c.id || 0;
        if (id) {
          const o = await sql`SELECT 1 FROM cargas WHERE id = ${id} AND transportadora_id = ${t} AND (${master}::boolean OR usuario_id = ${me.id})`;
          if (!o[0]) return bad(res, 'Carga não encontrada.', 404);
          await sql`UPDATE cargas SET embarcador = ${c.embarcador}, data_carregamento = ${c.data}, destino = ${c.destino || ''}, veiculo_id = ${V}, motorista_id = CASE WHEN ${master}::boolean THEN ${M} ELSE motorista_id END,
            numero_carga = ${c.numero || ''}, condutor = ${cond}, frete = ${+c.frete || 0}, status_pagamento = ${c.pagFrete} WHERE id = ${id}`;
        } else {
          const r = await sql`INSERT INTO cargas (transportadora_id, usuario_id, embarcador, data_carregamento, destino, veiculo_id, motorista_id, numero_carga, condutor, frete, status_pagamento)
            VALUES (${t}, ${me.id}, ${c.embarcador}, ${c.data}, ${c.destino || ''}, ${V}, ${M}, ${c.numero || ''}, ${cond}, ${+c.frete || 0}, ${c.pagFrete}) RETURNING id`;
          id = r[0].id;
        }
        await sql.transaction([
          sql`DELETE FROM notas_fiscais WHERE carga_id = ${id}`,
          sql`INSERT INTO notas_fiscais (carga_id, numero, cliente, valor, status) SELECT ${id}, x.numero, x.cliente, x.valor, x.status
              FROM jsonb_to_recordset(${nf}::jsonb) AS x(numero text, cliente text, valor numeric, status text)`,
          sql`DELETE FROM despesas WHERE carga_id = ${id}`,
          sql`INSERT INTO despesas (carga_id, tipo, valor, reembolso) SELECT ${id}, x.tipo, x.valor, x.reembolso
              FROM jsonb_to_recordset(${dp}::jsonb) AS x(tipo text, valor numeric, reembolso text)`,
        ]);
        return res.status(200).json({ id });
      }

      case 'del_carga':
        await sql`DELETE FROM cargas WHERE id = ${+b.id} AND transportadora_id = ${t} AND (${master}::boolean OR usuario_id = ${me.id})`;
        return ok();

      // ----- A partir daqui, somente o Master -----
      case 'save_cad': {
        if (!master) return bad(res, 'Acesso restrito ao Master.', 403);
        const r = b.rec || {}, id = +r.id || 0, s = v => String(v || '').trim();
        if (b.tab === 'clientes') {
          if (id) await sql`UPDATE clientes SET razao_social=${s(r.razao)}, nome_fantasia=${s(r.fantasia)}, cnpj=${s(r.cnpj)}, endereco=${s(r.endereco)}, contato=${s(r.contato)} WHERE id=${id} AND transportadora_id=${t}`;
          else await sql`INSERT INTO clientes (transportadora_id, razao_social, nome_fantasia, cnpj, endereco, contato) VALUES (${t}, ${s(r.razao)}, ${s(r.fantasia)}, ${s(r.cnpj)}, ${s(r.endereco)}, ${s(r.contato)})`;
        } else if (b.tab === 'motoristas') {
          if (!s(r.nome)) return bad(res, 'Informe o nome do motorista.');
          if (id) await sql`UPDATE motoristas SET nome=${s(r.nome)}, cnh=${s(r.cnh)}, categoria=${s(r.cat)} WHERE id=${id} AND transportadora_id=${t}`;
          else await sql`INSERT INTO motoristas (transportadora_id, nome, cnh, categoria) VALUES (${t}, ${s(r.nome)}, ${s(r.cnh)}, ${s(r.cat)})`;
        } else if (b.tab === 'veiculos') {
          if (!s(r.placa)) return bad(res, 'Informe a placa.');
          if (id) await sql`UPDATE veiculos SET perfil=${s(r.perfil)}, placa=${s(r.placa).toUpperCase()} WHERE id=${id} AND transportadora_id=${t}`;
          else await sql`INSERT INTO veiculos (transportadora_id, perfil, placa) VALUES (${t}, ${s(r.perfil)}, ${s(r.placa).toUpperCase()})`;
        } else if (b.tab === 'regioes') {
          if (!s(r.nome)) return bad(res, 'Informe o nome da região.');
          if (id) await sql`UPDATE regioes SET nome=${s(r.nome)} WHERE id=${id} AND transportadora_id=${t}`;
          else await sql`INSERT INTO regioes (transportadora_id, nome) VALUES (${t}, ${s(r.nome)})`;
        } else if (b.tab === 'usuarios') {
          const nome = s(r.usuario), senha = String(r.senha || ''), ativo = r.ativo !== 'Não';
          if (!nome) return bad(res, 'Informe o nome de usuário.');
          if (id) {
            if (senha && senha.length < 6) return bad(res, 'A senha precisa ter pelo menos 6 caracteres.');
            await sql`UPDATE usuarios SET usuario=${nome}, ativo=${ativo}, senha_hash = CASE WHEN ${senha} = '' THEN senha_hash ELSE crypt(${senha}, gen_salt('bf')) END
              WHERE id=${id} AND transportadora_id=${t} AND papel='usuario'`;
          } else {
            if (senha.length < 6) return bad(res, 'A senha precisa ter pelo menos 6 caracteres.');
            await sql`INSERT INTO usuarios (usuario, senha_hash, papel, transportadora_id, ativo) VALUES (${nome}, crypt(${senha}, gen_salt('bf')), 'usuario', ${t}, ${ativo})`;
          }
        } else return bad(res, 'Aba inválida.');
        return ok();
      }

      case 'del_cad': {
        if (!master) return bad(res, 'Acesso restrito ao Master.', 403);
        const id = +b.id;
        if (b.tab === 'clientes') await sql`DELETE FROM clientes WHERE id=${id} AND transportadora_id=${t}`;
        else if (b.tab === 'motoristas') await sql`DELETE FROM motoristas WHERE id=${id} AND transportadora_id=${t}`;
        else if (b.tab === 'veiculos') await sql`DELETE FROM veiculos WHERE id=${id} AND transportadora_id=${t}`;
        else if (b.tab === 'regioes') await sql`DELETE FROM regioes WHERE id=${id} AND transportadora_id=${t}`;
        else if (b.tab === 'usuarios') await sql`DELETE FROM usuarios WHERE id=${id} AND transportadora_id=${t} AND papel='usuario'`;
        else return bad(res, 'Aba inválida.');
        return ok();
      }

      case 'bulk_users': {
        if (!master) return bad(res, 'Acesso restrito ao Master.', 403);
        const linhas = String(b.texto || '').split('\n').map(l => l.trim()).filter(Boolean).slice(0, 100);
        let criados = 0, repetidos = 0, invalidos = 0;
        for (const l of linhas) {
          const [u, s] = l.split(/[;\t]/).map(x => (x || '').trim());
          if (!u || !s || s.length < 6) { invalidos++; continue; }
          try {
            await sql`INSERT INTO usuarios (usuario, senha_hash, papel, transportadora_id, ativo) VALUES (${u}, crypt(${s}, gen_salt('bf')), 'usuario', ${t}, true)`;
            criados++;
          } catch (e) { if (e.code === '23505') repetidos++; else throw e; }
        }
        return res.status(200).json({ criados, repetidos, invalidos });
      }

      case 'pass': {
        const nova = String(b.nova || '');
        if (nova.length < 8 || nova === 'Admin123') return bad(res, 'A nova senha precisa ter 8 ou mais caracteres e não pode ser Admin123.');
        const r = await sql`UPDATE usuarios SET senha_hash = crypt(${nova}, gen_salt('bf')) WHERE id = ${me.id} AND senha_hash = crypt(${String(b.atual || '')}, senha_hash) RETURNING id`;
        if (!r[0]) return bad(res, 'Senha atual incorreta.');
        return ok();
      }
    }
    return bad(res, 'Operação inválida.');
  } catch (e) {
    console.error(e);
    return bad(res, e.code === '23505' ? 'Já existe um registro igual (por exemplo, placa ou usuário repetido).' : 'Erro no servidor. Tente novamente.', e.code ? 400 : 500);
  }
}
