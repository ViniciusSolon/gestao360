# Frases de comportamento dos testes (describe / it)

Gerado a partir de `apps/api/test/*.spec.ts`. **Você é a fonte da verdade**: confirme ou corrija cada frase.
Cada teste chama a rota real com banco de teste real; só gateway de pagamento e e-mail são simulados.

Resultado da última execução: **85 passando, 0 falhando**.

## describe: Leads e funil Kanban  
<sub>apps/api/test/crm.spec.ts</sub>

- ✅ it: quando cria um lead, então a pontuação e o MQL são calculados no servidor (ignora score enviado)
- ✅ it: quando move o lead para "Ganho", então status=won e closed_at preenchido; para "Perdido" exige motivo
- ✅ it: quando o valor do lead é negativo, então 400
- ✅ it: quando o plano atinge o limite de leads e dois leads são criados ao mesmo tempo, então só um entra
- ✅ it: quando o mesmo lead é apagado duas vezes ao mesmo tempo, então a cota é devolvida uma vez
- ✅ it: quando a atividade é concluída duas vezes ao mesmo tempo, então gera um único evento no histórico
- ✅ it: quando o link de reunião não é https (ex.: javascript:), então 400

## describe: Permissões por papel (servidor)  
<sub>apps/api/test/crm.spec.ts</sub>

- ✅ it: quando o vendedor tenta criar produto, convidar, criar etapa ou apagar lead, então 403
- ✅ it: quando o admin tenta promover alguém a owner ou alterar o owner, então é recusado
- ✅ it: quando gerente tenta checkout de plano (só owner), então 403

## describe: Propostas  
<sub>apps/api/test/crm.spec.ts</sub>

- ✅ it: quando cria proposta, então preço e tributo vêm do cadastro (valores enviados pelo cliente são ignorados)
- ✅ it: quando o vendedor dá desconto acima de 10%, então 403; quando o gerente dá 15%, então aceita
- ✅ it: quando falta Idempotency-Key, então 400
- ✅ it: quando a mesma Idempotency-Key é reenviada (clique duplo / retry), então devolve a mesma resposta e cria uma só proposta
- ✅ it: quando duas requisições com a mesma Idempotency-Key chegam ao mesmo tempo, então só uma proposta é criada
- ✅ it: quando a mesma chave é usada com outro corpo, então 422
- ✅ it: quando várias propostas diferentes são criadas ao mesmo tempo, então os números são sequenciais e sem repetição
- ✅ it: quando a proposta é aceita duas vezes ao mesmo tempo, então só um aceite vale e o lead fica ganho
- ✅ it: quando duas propostas do mesmo lead são aceitas ao mesmo tempo, então só uma fica aceita
- ✅ it: quando gera o PDF, então devolve application/pdf
- ✅ it: quando quantidade é zero ou negativa, ou frete negativo, então 400
- ✅ it: quando o produto está inativo, então não pode entrar em proposta

## describe: Conta bloqueada  
<sub>apps/api/test/crm.spec.ts</sub>

- ✅ it: quando o trial venceu, então as rotas de negócio respondem 402 mas a cobrança continua acessível
- ✅ it: quando a conta está suspensa, então 402 em tudo que é de negócio

## describe: Cadastro (signup)  
<sub>apps/api/test/auth.spec.ts</sub>

- ✅ it: quando os dados são válidos, então cria empresa em trial, usuário owner, funil padrão e sessão
- ✅ it: quando a senha é curta ou o e-mail inválido, então responde 400 sem criar nada
- ✅ it: quando o e-mail já existe, então responde 409
- ✅ it: quando dois cadastros com o mesmo e-mail chegam ao mesmo tempo, então só um cria empresa
- ✅ it: quando a requisição vem de uma origem não autorizada, então responde 403 (CSRF)
- ✅ it: quando o corpo é text/plain (formulário cross-site), então é rejeitado

## describe: Login e sessão  
<sub>apps/api/test/auth.spec.ts</sub>

- ✅ it: quando a senha confere, então cria sessão; quando não confere, então 401 genérico
- ✅ it: quando faz logout, então o cookie antigo deixa de funcionar
- ✅ it: quando não há cookie ou o cookie é forjado, então 401
- ✅ it: quando o usuário é desativado, então a sessão dele para de funcionar na hora

## describe: Convites e limite de usuários do plano  
<sub>apps/api/test/auth.spec.ts</sub>

- ✅ it: quando o admin convida, então enfileira e envia o e-mail uma única vez
- ✅ it: quando o nome de quem convida tem HTML, então o e-mail sai com o texto escapado
- ✅ it: quando clica duas vezes em convidar (mesmo e-mail, ao mesmo tempo), então existe só um convite pendente
- ✅ it: quando o mesmo convite é aceito duas vezes ao mesmo tempo, então só um usuário é criado e só uma vaga é consumida
- ✅ it: quando o plano (Starter: 3 usuários) está cheio e dois convites são aceitos ao mesmo tempo, então só um entra
- ✅ it: quando o token de convite é inválido, então responde 410
- ✅ it: quando o mesmo usuário é desativado duas vezes ao mesmo tempo, então a vaga é devolvida uma vez só

## describe: Isolamento entre empresas (usuário A x dados da empresa B)  
<sub>apps/api/test/isolation.spec.ts</sub>

- ✅ it: quando A lista leads, produtos, atividades, propostas e usuários, então não vê nada de B
- ✅ it: quando A tenta ler, alterar, mover ou apagar o lead de B pelo ID, então recebe 404 e nada muda
- ✅ it: quando A tenta usar produto ou lead de B numa proposta, então é recusado
- ✅ it: quando A tenta ler o PDF, enviar ou aceitar a proposta de B, então 404
- ✅ it: quando A tenta alterar produto, atividade, etapa ou usuário de B, então 404
- ✅ it: quando A cria lead apontando etapa ou responsável de B, então o banco recusa (FK composta por tenant)
- ✅ it: quando o papel da API (g360_app) consulta sem tenant definido, então o RLS não devolve nenhuma linha
- ✅ it: quando o papel da API tenta gravar linha com tenant_id de outra empresa, então o RLS bloqueia

## describe: Visibilidade dentro da empresa (vendedor x vendedor)  
<sub>apps/api/test/isolation.spec.ts</sub>

- ✅ it: quando o vendedor 1 tenta ver ou alterar o lead do vendedor 2, então 404
- ✅ it: quando o vendedor tenta atribuir lead ou atividade a outra pessoa, então 403
- ✅ it: quando o vendedor consulta o dashboard, então vê só os próprios números

## describe: Checkout (chamadas ao gateway)  
<sub>apps/api/test/billing.spec.ts</sub>

- ✅ it: quando o owner inicia o checkout, então o gateway recebe uma idempotency key UUID v4 e o preço vem do servidor
- ✅ it: quando o cliente repete a mesma Idempotency-Key, então devolve a mesma resposta sem chamar o gateway de novo
- ✅ it: quando o cliente tenta de novo com outra chave (nova tentativa da mesma operação), então o gateway recebe a MESMA idempotency key
- ✅ it: quando dois checkouts do mesmo plano chegam ao mesmo tempo, então existe uma única operação e uma única chave
- ✅ it: quando o plano não existe, então 404

## describe: Webhook de pagamento  
<sub>apps/api/test/billing.spec.ts</sub>

- ✅ it: quando a assinatura é inválida, ausente ou expirada, então 401 e nada é registrado
- ✅ it: quando o corpo é alterado depois de assinado, então 401 (assinatura sobre o corpo bruto)
- ✅ it: quando o pagamento é confirmado, então a conta vira ativa no plano pago e o e-mail sai uma vez
- ✅ it: quando o mesmo evento chega 2 vezes, então o efeito acontece uma vez (segundo responde 200 duplicate)
- ✅ it: quando o mesmo evento chega 2 vezes AO MESMO TEMPO, então só um é processado
- ✅ it: quando eventos diferentes da mesma assinatura chegam fora de ordem, então vale o estado atual do gateway
- ✅ it: quando a conta foi suspensa pela plataforma, então um pagamento não a reativa sozinho
- ✅ it: quando o evento não tem relação com assinatura, então responde 200 e não enfileira nada
- ✅ it: quando o pagamento falha (past_due), então a conta fica past_due e continua utilizável

## describe: Painel da plataforma — autenticação e papéis  
<sub>apps/api/test/platform.spec.ts</sub>

- ✅ it: quando não está logado, então 401 em todas as rotas
- ✅ it: quando um usuário de empresa cliente (mesmo owner) usa seu cookie no painel, então 401
- ✅ it: quando a senha está errada, então 401
- ✅ it: quando o suporte (somente leitura) tenta suspender, trocar plano ou estender trial, então 403

## describe: Painel da plataforma — controle dos clientes  
<sub>apps/api/test/platform.spec.ts</sub>

- ✅ it: quando o superadmin suspende um cliente, então o cliente é bloqueado na hora e a ação fica auditada
- ✅ it: quando lista clientes e métricas, então mostra plano, status, uso e MRR
- ✅ it: quando abre o detalhe do cliente, então NÃO expõe dados de negócio (leads), só metadados de uso
- ✅ it: quando estende o trial, então a data avança; quando o cliente não está em trial, então 422
- ✅ it: quando a plataforma troca o plano, então o limite novo vale imediatamente

## describe: Configuração de startup  
<sub>apps/api/test/unit.spec.ts</sub>

- ✅ it: quando falta o segredo do webhook, então não sobe
- ✅ it: quando o segredo é fraco/padrão ou curto, então não sobe
- ✅ it: quando é produção com gateway fake ou cookie inseguro, então não sobe

## describe: Regras de preço  
<sub>apps/api/test/unit.spec.ts</sub>

- ✅ it: calcula item com quantidade fracionada e arredondamento half-up
- ✅ it: soma totais e rejeita frete negativo
- ✅ it: limita desconto por papel
- ✅ it: pontua lead entre 0 e 100

## describe: Assinatura de webhook  
<sub>apps/api/test/unit.spec.ts</sub>

- ✅ it: aceita assinatura válida e recusa corpo alterado, segredo errado e timestamp velho

## describe: Diversos  
<sub>apps/api/test/unit.spec.ts</sub>

- ✅ it: escapa HTML
- ✅ it: mapeia status do gateway
