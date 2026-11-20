# Controle · Transportadora

Sistema de controle de cargas (Vercel + Neon Postgres).

## Publicar (uma vez)
1. **GitHub:** crie um repositório privado e envie todos os arquivos desta pasta, mantendo as pastas `api/` e `db/`.
2. **Vercel:** *Add New → Project*, importe o repositório e clique em *Deploy* (Framework: Other).
3. **Banco:** no painel do Neon (neon.tech), abra o projeto `controle-transportadora`, clique em *Connect* e copie a *connection string*.
   Na Vercel: projeto → *Settings → Environment Variables* → crie `DATABASE_URL` com esse valor (todos os ambientes) → *Deployments → Redeploy*.
   (Se a integração Neon da Vercel já tiver criado outra `DATABASE_URL`, edite-a com o valor do projeto `controle-transportadora`.)
4. **Primeiro acesso:** usuário `Administrador`, senha `Admin123`. Troque a senha imediatamente (botão *Trocar senha*).

## Acessos
- **Master:** vê Painel, Cargas e Cadastros (clientes, motoristas, veículos e usuários). Cria os acessos de Usuário.
- **Usuário:** vê apenas Painel e Cargas.
- As regras são aplicadas no servidor (`api/app.js`).

## Nova transportadora (cliente seu)
No Neon (*SQL Editor*), troque os textos e execute:

    WITH t AS (INSERT INTO transportadoras (nome) VALUES ('Nome da transportadora') RETURNING id)
    INSERT INTO usuarios (usuario, senha_hash, papel, transportadora_id)
    SELECT 'master_da_empresa', crypt('SenhaForte123', gen_salt('bf')), 'master', id FROM t;

Os dados de cada transportadora ficam totalmente separados.
