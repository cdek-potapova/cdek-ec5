# cdek-ec5
EC5 traffic collector userscript (auto-update host)

Этот репозиторий — **канал автообновления** для Tampermonkey на четырёх ПВЗ
(ТЯК, Садовод-1, Садовод-2, Фуд-Сити). Файл `ec5-collector.user.js` раздаётся по
`raw.githubusercontent.com`, точки подтягивают его сами. Разработка — в приватном
`Newcom12/ec5-traffic`, сюда кладётся только готовый файл.

## Откат

Просто вернуть старый файл НЕДОСТАТОЧНО: Tampermonkey ставит обновление, только если
`@version` в раздаваемом файле **больше** установленной. Чтобы откатиться, нужно
опубликовать старый код под НОВЫМ, бОльшим номером версии:

```
git show <старый-коммит>:ec5-collector.user.js > ec5-collector.user.js
# поднять @version выше текущей (например тело 0.8.0 под номером 0.9.1)
git commit -am "откат к 0.8.0 под версией 0.9.1" && git push
```

Проверка, что раздаётся:
```
curl -s https://raw.githubusercontent.com/Newcom12/cdek-ec5/main/ec5-collector.user.js | head -5
```
