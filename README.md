# King's Newsletter — worker

Worker local em Node.js + Express para executar verificações periódicas, separado do acesso à página de edições. O intervalo padrão é de 3 horas. A integração HTTP fica deliberadamente sem rota/método padrão: configure-a somente após confirmar o contrato oficial da API. Este projeto não envia e-mails.

## Requisitos e início

- Node.js 20 ou superior
- Copie `.env.example` para `.env` e preencha apenas valores fornecidos/documentados pelo proprietário da API.
- `npm install`
- `npm test`
- `npm start`

O health check local fica em `GET /health`. Se `PORT` estiver vazio, o sistema operacional escolhe uma porta livre e o worker registra o número no log de inicialização; `HOST` usa `localhost` por padrão. Em hospedagens, o worker aceita a porta fornecida pelo ambiente. Configure `SCHEDULER_ENABLED=false` para manter o processo sem agendador.

## Integração

Defina `NEWSLETTER_API_BASE_URL` com a URL pública do site e `NEWSLETTER_API_TOKEN` com `NOTIFY_SECRET`, guardado como segredo local. O exemplo já configura `POST /api/notify-news`, rota confirmada no código do site. O worker só chama a API quando URL e token estão definidos; o token segue no cabeçalho Bearer. Nunca coloque segredos no repositório. A resposta é registrada sem interpretar campos ou imprimir o corpo.

## Controle pelo painel

Configure `WORKER_CONTROL_SECRET` no `.env` do worker e no ambiente do site com o mesmo valor aleatório de pelo menos 32 caracteres. Esse segredo é separado de `NEWSLETTER_API_TOKEN`/`NOTIFY_SECRET`: o segredo de controle só autentica a leitura das configurações e o envio dos heartbeats. Nunca o exponha no navegador, registre-o em logs ou o versione.

O worker inicia conexões HTTPS de saída com o site, consulta a configuração a cada 30 segundos e envia um heartbeat com o estado e a próxima execução. O painel `/admin` permite escolher um intervalo inteiro de 1 a 168 horas e pausar ou retomar o agendamento. A alteração é aplicada na próxima sincronização. Não é preciso expor uma porta do worker à internet nem configurar um IP público fixo. A newsletter não chama o worker: ela armazena a configuração e recebe os heartbeats; é o worker que inicia a comunicação, usando a URL pública do site em `NEWSLETTER_API_BASE_URL`. O `HOST` e o `PORT` locais do worker não participam dessa integração.

## Agendamento, fuso e operação

O intervalo local padrão é em milissegundos (`CHECK_INTERVAL_MS`, padrão 10800000) quando o controle remoto não está configurado. Com o painel conectado, a configuração salva no MongoDB do site prevalece. O contador do painel usa o próximo horário informado pelo processo; o status fica offline quando não há heartbeat por 90 segundos. O processo precisa permanecer ativo para executar as verificações. Datas de log usam ISO 8601 UTC e também apresentam a data/hora civil em `America/Rio_Branco`, com conversão feita pela API Intl do Node.

O agendador impede sobreposição dentro deste processo. Para múltiplas instâncias, implemente um lock distribuído ou fila antes de escalar.

## Retry e idempotência

O cliente implementa retry limitado para falhas transitórias e `Retry-After`, sem repetir erros HTTP permanentes. O esqueleto não executa ações mutáveis. Antes de acrescentar efeitos colaterais, use uma chave idempotente derivada do identificador estável da edição/evento confirmado pelo contrato da API e persista seu resultado em armazenamento durável. Não dependa do estado em memória para deduplicação entre reinícios/instâncias.

## Segurança

Não registre tokens, cabeçalhos de autenticação ou corpo integral de respostas. Restrinja acesso à porta conforme o ambiente de hospedagem. O endpoint de saúde retorna somente estado básico.


