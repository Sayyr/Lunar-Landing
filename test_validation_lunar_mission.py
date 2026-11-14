r"""Lunar Mission - test ENU et validation croisee SPICE sur plusieurs sites.

Execution dans VS Code (PowerShell), depuis le dossier du projet :
    .\.venv\Scripts\python.exe .\test_validation_lunar_mission.py

Les cinq kernels du projet doivent se trouver dans ./kernels/.
"""

import csv
import math
from pathlib import Path

import numpy as np

try:
    import spiceypy as sp
except ImportError:
    sp = None


DOSSIER = Path(__file__).resolve().parent
R_LUNE_KM = 1737.4  # Approximation spherique de Lunar Mission
SEUIL_DEGRES = 0.001

# (nom, latitude degres, longitude EST degres, altitude km)
SITES = [
    ("Reference",       -85.0,  -30.0, 1.5),
    ("Pres pole Sud",    -89.5,   45.0, 0.5),
    ("Sud autre cote",   -70.0,  120.0, 2.0),
    ("Hemisphere Sud",   -30.0, -160.0, 0.0),
    ("Equateur 0",         0.0,    0.0, 0.0),
    ("Equateur Est",       0.0,   90.0, 1.0),
    ("Hemisphere Nord",   45.0, -135.0, 0.2),
    ("Pres pole Nord",    89.0,   10.0, 0.0),
]

DATES_UTC = [
    "2026 NOV 14 12:00:00 UTC",
    "2026 DEC 01 12:00:00 UTC",
    "2027 MAY 01 00:00:00 UTC",
]


def construire_site(latitude_deg, longitude_deg, altitude_km):
    if not (-90 < latitude_deg < 90):
        raise ValueError("Pole exact : definir une convention nord specifique")
    if not all(math.isfinite(x) for x in (latitude_deg, longitude_deg, altitude_km)):
        raise ValueError("Coordonnee non finie")
    if R_LUNE_KM + altitude_km <= 0:
        raise ValueError("Distance au centre de la Lune invalide")

    phi = math.radians(latitude_deg)
    lam = math.radians(longitude_deg)
    cphi, sphi = math.cos(phi), math.sin(phi)
    clam, slam = math.cos(lam), math.sin(lam)
    rayon = R_LUNE_KM + altitude_km

    obspos = rayon * np.array([cphi * clam, cphi * slam, sphi])
    east = np.array([-slam, clam, 0.0])
    north = np.array([-sphi * clam, -sphi * slam, cphi])
    up = np.array([cphi * clam, cphi * slam, sphi])
    return obspos, east, north, up


def angles_enu(direction, east, north, up):
    E = float(np.dot(direction, east))
    N = float(np.dot(direction, north))
    U = float(np.dot(direction, up))
    if np.linalg.norm(direction) == 0:
        raise ValueError("Vecteur cible nul")
    if math.hypot(E, N) < 1e-13 * np.linalg.norm(direction):
        # Azimut non defini au zenith ou au nadir.
        return None, math.degrees(math.atan2(U, math.hypot(E, N)))
    az = math.degrees(math.atan2(E, N)) % 360.0
    el = math.degrees(math.atan2(U, math.hypot(E, N)))
    return az, el


def ecart_azimut(a, b):
    return abs((a - b + 180.0) % 360.0 - 180.0)


def test_maths():
    """Verification locale ne necessitant ni SPICE ni kernels."""
    controles = 0
    for nom, lat, lon, h in SITES:
        obspos, east, north, up = construire_site(lat, lon, h)
        M = np.vstack((east, north, up))
        assert np.allclose(M @ M.T, np.eye(3), atol=1e-12), nom
        assert np.isclose(np.linalg.det(M), 1.0, atol=1e-12), nom
        assert np.isclose(np.linalg.norm(obspos), R_LUNE_KM + h, atol=1e-10), nom
        controles += 3

        # Directions synthetiques, avec valeurs attendues exactes.
        cas = [
            (north, 0.0, 0.0),
            (east, 90.0, 0.0),
            (-north, 180.0, 0.0),
            (-east, 270.0, 0.0),
            ((east + up) / math.sqrt(2), 90.0, 45.0),
            ((north + east) / math.sqrt(2), 45.0, 0.0),
            ((north + up) / math.sqrt(2), 0.0, 45.0),
        ]
        for v, az_attendu, el_attendu in cas:
            az, el = angles_enu(v, east, north, up)
            assert az is not None and ecart_azimut(az, az_attendu) < 1e-9, (nom, az)
            assert abs(el - el_attendu) < 1e-9, (nom, el)
            controles += 1

        az_zenith, el_zenith = angles_enu(up, east, north, up)
        assert az_zenith is None and abs(el_zenith - 90) < 1e-9, nom
        controles += 1

    print(f"[OK] Tests mathematiques ENU : {controles} controles sur {len(SITES)} sites")


def test_spice():
    """Deux calculs distincts utilisant les memes ephemerides NASA."""
    if sp is None:
        print("[NON EXECUTE] SpiceyPy absent dans cet environnement.")
        return

    kernel_dir = DOSSIER / "kernels"
    noms_kernels = [
        "naif0012.tls",
        "de440s.bsp",
        "pck00011.tpc",
        "moon_pa_de440_200625.bpc",
        "moon_de440_250416.tf",
    ]
    manquants = [x for x in noms_kernels if not (kernel_dir / x).is_file()]
    if manquants:
        print("[NON EXECUTE] Kernels manquants dans", kernel_dir)
        print("  ", ", ".join(manquants))
        return

    lignes = []
    echecs = []
    max_az = max_el = 0.0
    try:
        for name in noms_kernels:
            sp.furnsh(str(kernel_dir / name))

        rayons = sp.bodvrd("MOON", "RADII", 3)[1]
        if not np.allclose(rayons, R_LUNE_KM, atol=1e-6):
            raise ValueError(f"Rayons du PCK incompatibles avec R={R_LUNE_KM} km: {rayons}")

        for date in DATES_UTC:
            et = sp.str2et(date)
            for nom, lat, lon, h in SITES:
                obspos, east, north, up = construire_site(lat, lon, h)
                for cible in ("SUN", "EARTH"):
                    state, _ = sp.spkcpo(
                        cible, et, "MOON_ME", "OBSERVER", "CN+S",
                        obspos, "MOON", "MOON_ME"
                    )
                    az, el = angles_enu(state[:3], east, north, up)
                    azel_state, _ = sp.azlcpo(
                        "ELLIPSOID", cible, et, "CN+S",
                        False, True, obspos, "MOON", "MOON_ME"
                    )
                    az_ref = math.degrees(azel_state[1]) % 360.0
                    el_ref = math.degrees(azel_state[2])
                    if az is None:
                        raise ValueError(f"Azimut indefini pour {nom}, {date}, {cible}")
                    d_az = ecart_azimut(az, az_ref)
                    d_el = abs(el - el_ref)
                    max_az = max(max_az, d_az)
                    max_el = max(max_el, d_el)
                    ok = d_az < SEUIL_DEGRES and d_el < SEUIL_DEGRES
                    if not ok:
                        echecs.append((nom, date, cible, d_az, d_el))
                    lignes.append({
                        "site": nom, "latitude_deg": lat, "longitude_est_deg": lon,
                        "altitude_km": h, "date_utc": date, "astre": cible,
                        "az_spkcpo_deg": round(az, 8), "el_spkcpo_deg": round(el, 8),
                        "az_azlcpo_deg": round(az_ref, 8), "el_azlcpo_deg": round(el_ref, 8),
                        "ecart_az_deg": round(d_az, 10), "ecart_el_deg": round(d_el, 10),
                        "validation": "OK" if ok else "ECHEC",
                    })
                    print(f"{date[:11]} | {nom:18} | {cible:5} | "
                          f"az={az:9.4f}  el={el:9.4f} | "
                          f"ecarts={d_az:.7f} / {d_el:.7f} deg | "
                          f"{'OK' if ok else 'ECHEC'}")

        # Test de regression : retrouver le premier calcul communique par l'equipe.
        reference = [x for x in lignes if x["site"] == "Reference"
                     and x["date_utc"] == DATES_UTC[0]]
        attendus = {"SUN": (150.4971, -2.7963), "EARTH": (28.0084, 0.2914)}
        for x in reference:
            az0, el0 = attendus[x["astre"]]
            if ecart_azimut(x["az_spkcpo_deg"], az0) >= 0.01 or abs(x["el_spkcpo_deg"] - el0) >= 0.01:
                echecs.append(("Reference historique", DATES_UTC[0], x["astre"],
                               x["az_spkcpo_deg"], x["el_spkcpo_deg"]))

        sortie = DOSSIER / "resultats_validation.csv"
        with sortie.open("w", newline="", encoding="utf-8-sig") as fichier:
            writer = csv.DictWriter(fichier, fieldnames=list(lignes[0].keys()), delimiter=";")
            writer.writeheader()
            writer.writerows(lignes)

        print("\n========== BILAN ==========")
        print(f"Sites testes             : {len(SITES)}")
        print(f"Dates testees            : {len(DATES_UTC)}")
        print(f"Comparaisons SPICE       : {len(lignes)}")
        print(f"Ecart maximal azimut     : {max_az:.10f} deg")
        print(f"Ecart maximal elevation  : {max_el:.10f} deg")
        print(f"Nombre d'echecs          : {len(echecs)}")
        print(f"Rapport CSV              : {sortie}")
        if echecs:
            for x in echecs[:10]:
                print("ECHEC :", x)
            raise AssertionError("Validation croisee SPICE non reussie")
        print("[OK] Validation croisee SPICE reussie (coherence interne)")
        print("Note : ceci ne remplace pas une validation independante avec JPL Horizons.")
    finally:
        sp.kclear()


if __name__ == "__main__":
    test_maths()
    test_spice()
