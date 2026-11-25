# Pellet – zużycie i zapas pelletu

Aplikacja na telefon (PWA) do zapisywania dosypanych worków, zakupów i dostawców.
Prognozuje, na ile wystarczy pelletu i kiedy zamówić kolejną dostawę.

- działa bez internetu, dane trzyma **tylko na telefonie** (localStorage),
- kopia zapasowa: plik JSON (wysyłka mailem / zapis na Dysku), import z pliku, eksport CSV do Excela,
- bez serwera, bez kont, bez kroku budowania – zwykłe pliki HTML/CSS/JS.

## Jak liczy prognozę

1. **Stan magazynu** = ostatni spis z natury + zakupy − dosypane worki.
2. **Model zużycia**: `kg/dobę = a + b × max(0, 18 °C − średnia temperatura dnia)`.
   Pellet wsypany przy jednym dosypaniu spala się do następnego, więc z okresów
   między dosypaniami (ostatnie 120 dni) i temperatur z Open-Meteo dopasowywane są `a` i `b`.
   - za mało danych lub brak lokalizacji → średnie zużycie z ostatnich 30 dni,
   - brak danych → zużycie wpisane w Ustawieniach.
3. **Symulacja dzień po dniu**: przez 16 dni prognoza pogody, dalej średnie wieloletnie
   (5 lat archiwum Open-Meteo) – aż do wyczerpania zapasu.
4. **Widełki** (wersja ostrożna / optymistyczna) z błędu dopasowania modelu.
   „Zamów do” = wersja ostrożna − czas dostawy − zapas bezpieczeństwa.

Model pogodowy włącza się po ok. 2 tygodniach wpisów (min. 4 okresy między dosypaniami).

## Uruchomienie na telefonie

Instalacja na ekranie głównym wymaga adresu **https**. Najprościej (za darmo):

- **Netlify Drop**: wejdź na https://app.netlify.com/drop i przeciągnij folder projektu.
- **GitHub Pages**: wrzuć pliki do repozytorium → Settings → Pages → branch `main`.

Potem otwórz adres na telefonie:
- **Android (Chrome)**: menu ⋮ → „Dodaj do ekranu głównego” / „Zainstaluj aplikację”,
- **iPhone (Safari)**: Udostępnij → „Do ekranu początkowego”.

Lokalnie na komputerze: `python -m http.server 8000` w folderze projektu → http://localhost:8000

## Ważne

- Dane są przypisane do przeglądarki i adresu strony. Zmiana adresu, wyczyszczenie danych
  przeglądarki lub odinstalowanie aplikacji je usuwa – **rób kopię zapasową** (zakładka Więcej).
- Po zmianie plików aplikacji podbij `VERSION` w [sw.js](sw.js).

## Pliki

| Plik | Co robi |
|---|---|
| [index.html](index.html), [styles.css](styles.css) | szkielet i wygląd (tryb jasny/ciemny) |
| [js/app.js](js/app.js) | ekrany, formularze, wykresy |
| [js/forecast.js](js/forecast.js) | stan magazynu, model zużycia, prognoza |
| [js/weather.js](js/weather.js) | pogoda z Open-Meteo z buforem |
| [js/store.js](js/store.js) | zapis danych, kopia zapasowa |
| [sw.js](sw.js), [manifest.webmanifest](manifest.webmanifest) | działanie offline i instalacja |
