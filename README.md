# alikhvn: цифровой двойник участка медного карьера на OpenEgiz

Team Repository конкурса «Digital Mine on OpenEgiz». Концепция, список двойников, сценарии — в [SUBMISSION.md](SUBMISSION.md).

## Запуск

Требования (Docker, `make`, настройка Windows/WSL2) — в [OPENEGIZ.md](OPENEGIZ.md) / [OPENEGIZ.ru.md](OPENEGIZ.ru.md). Нужно ~6 ГБ памяти для Docker.

```bash
sudo apt install -y make   # если make нет (чистый Ubuntu)
make team-mine              # платформа OpenEgiz + наш участок карьера: двойники, симулятор, 3D-сцена
```

Одна команда поднимает всё: платформу (Ditto, MQTT, InfluxDB, Grafana), создаёт 26 двойников нашего участка, запускает симулятор и 3D-вьюер. Первый запуск скачивает образы и собирает наши — несколько минут; дальше — быстрее.

## Что открыть

- **3D-сцена участка: http://localhost:8091** — главная визуализация: карьер, самосвалы, дороги, панели сценариев «что если», диспетчеризации и контроля качества руды. Подробнее — [team/mine/README.md](team/mine/README.md).
- **Grafana**: адрес и логин печатает `make team-mine` (по умолчанию http://localhost:3000, `admin` / сгенерированный пароль в `deploy/compose/.env`). Приложение **OpenEgiz → Twins** показывает все двойники и их состояние напрямую; Explore → InfluxDB — сырая телеметрия (`mqtt_consumer`, тег `thingId` с префиксом `org.openegiz.pit:`).
- **Ditto API**: `http://localhost:8080/api/2`, логин `ditto` / пароль из `deploy/compose/.env`.

## Проверка

```bash
make ps                           # все сервисы, включая team-mine-setup/-simulator/-viewer, должны быть Up/Exited(0)
make tail S=team-mine-setup       # должно быть "26 twins ready"
make tail S=team-mine-simulator   # раз в ~30с строка "sim NNN min | crusher ..."
```

Подробный пошаговый чеклист (включая проверку сценариев «что если» через Ditto API) — [team/mine/README.md](team/mine/README.md#проверка).

## Структура репозитория

| Путь | Содержимое |
|---|---|
| `team/mine/` | Код участка: двойники (`constants.py`, `generate_twins.py` → `twins.json`), симулятор (`simulator.py`, SimPy), 3D-вьюер (`viewer/`), Docker/compose-обвязка |
| `team/docs/design-twins.md` | Схема участка, полный список двойников, источники всех цифр, живая верификация |
| `SUBMISSION.md` | Описание решения: **обязателен** |
| `presentation.pdf` | Презентация: **обязательна**, в корне репозитория |
| `AGENTS.md`, `CLAUDE.md`* | Инструкции для ИИ-агентов команды (`CLAUDE.md` не коммитится, см. `.git/info/exclude`) |
| `examples/mine/` | Пример рудника платформы: показывает, как устроен цифровой рудник на OpenEgiz, не основа решения |
| `OPENEGIZ.md`, `OPENEGIZ.ru.md` | Документация платформы OpenEgiz v1.0.4 |

Решение — содержимое ветки `main` на момент Заморозки; другие ветки не оцениваются.

## Лицензия

MIT, см. [LICENSE](LICENSE).

---

Платформа: [aleka07/openegiz](https://github.com/aleka07/openegiz).
