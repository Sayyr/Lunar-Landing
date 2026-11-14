import csv
import numpy as np
import spiceypy as sp
from pathlib import Path
from scipy.integrate import solve_ivp
from scipy.optimize import brentq, fsolve

# ============================================
# LUNAR MISSION
# Trajectoire Terre -> site lunaire
# + positions du Soleil et de la Terre vues du site a l'arrivee
# Calcul avec NASA SPICE
# ============================================

# Constantes gravitationnelles (km^3/s^2), valeurs DE440
GM_EARTH = 398600.435436
GM_MOON = 4902.800066
GM_SUN = 132712440041.939400
R_EARTH = 6378.137
R_MOON = 1737.4


# ============================================
# 1. OUTILS SPICE
# ============================================

def charger_kernels():
    folder = Path(__file__).resolve().parent / "kernels"
    kernels = [
        "naif0012.tls",              # Gerer le temps
        "de440s.bsp",                # Positions des astres
        "pck00011.tpc",              # Dimensions et constantes planetaires
        "moon_pa_de440_200625.bpc",  # Orientation reelle de la Lune
        "moon_de440_250416.tf",      # Reperes lunaires (MOON_ME)
    ]
    for filename in kernels:
        path = folder / filename
        if not path.is_file():
            raise FileNotFoundError(f"Kernel manquant : {path}")
        sp.furnsh(str(path))


def position_site_moon_me(latitude, longitude, altitude_km):
    """Position du site dans MOON_ME (Lune spherique), comme dans le code 1."""
    phi, lam = np.radians(latitude), np.radians(longitude)
    r = R_MOON + altitude_km
    return np.array([r * np.cos(phi) * np.cos(lam),
                     r * np.cos(phi) * np.sin(lam),
                     r * np.sin(phi)])


def etat_lune(et):
    """Etat (position, vitesse) de la Lune vue de la Terre, J2000, km et km/s."""
    state, _ = sp.spkezr("MOON", et, "J2000", "NONE", "EARTH")
    return np.array(state[:3]), np.array(state[3:])


def position_soleil(et):
    pos, _ = sp.spkpos("SUN", et, "J2000", "NONE", "EARTH")
    return np.array(pos)


def site_en_j2000(obspos_me, et):
    """Position du site vue de la Terre (J2000) a l'instant et."""
    rot = np.array(sp.pxform("MOON_ME", "J2000", et))
    r_lune, _ = etat_lune(et)
    return r_lune + rot @ obspos_me


# ============================================
# 2. DYNAMIQUE : Terre + Lune + Soleil
# Repere J2000 centre Terre (non inertiel) :
# il faut ajouter le terme "indirect" (acceleration de la Terre
# elle-meme vers la Lune et le Soleil).
# ============================================

def equations_of_motion(t, state):
    r = state[:3]
    v = state[3:]

    r_lune, _ = etat_lune(t)
    r_soleil = position_soleil(t)

    acc = -GM_EARTH * r / np.linalg.norm(r) ** 3

    for gm, rb in ((GM_MOON, r_lune), (GM_SUN, r_soleil)):
        d = rb - r
        acc += gm * (d / np.linalg.norm(d) ** 3 - rb / np.linalg.norm(rb) ** 3)

    return np.concatenate([v, acc])


def collision_lune(t, state):
    r_lune, _ = etat_lune(t)
    return np.linalg.norm(state[:3] - r_lune) - R_MOON


collision_lune.terminal = False


def propager(state0, et_dep, et_arr, n_points=None):
    t_eval = None if n_points is None else np.linspace(et_dep, et_arr, n_points)
    return solve_ivp(equations_of_motion, (et_dep, et_arr), state0,
                     t_eval=t_eval, method="DOP853",
                     rtol=1e-10, atol=1e-9, events=collision_lune)


# ============================================
# 3. PROBLEME DE LAMBERT (Terre seule) = estimation initiale
# Variables universelles (Curtis, Orbital Mechanics for Engineering Students)
# ============================================

def stumpff_c(z):
    if z > 0:
        return (1 - np.cos(np.sqrt(z))) / z
    if z < 0:
        return (np.cosh(np.sqrt(-z)) - 1) / (-z)
    return 0.5


def stumpff_s(z):
    if z > 0:
        s = np.sqrt(z)
        return (s - np.sin(s)) / s ** 3
    if z < 0:
        s = np.sqrt(-z)
        return (np.sinh(s) - s) / s ** 3
    return 1 / 6


def lambert(r1, r2, tof, mu, normale):
    """Vitesses v1, v2 pour aller de r1 a r2 en tof secondes (sens de 'normale')."""
    n1, n2 = np.linalg.norm(r1), np.linalg.norm(r2)
    cos_t = np.clip(np.dot(r1, r2) / (n1 * n2), -1, 1)
    theta = np.arccos(cos_t)
    if np.dot(np.cross(r1, r2), normale) < 0:
        theta = 2 * np.pi - theta

    A = np.sin(theta) * np.sqrt(n1 * n2 / (1 - np.cos(theta)))

    def y(z):
        return n1 + n2 + A * (z * stumpff_s(z) - 1) / np.sqrt(stumpff_c(z))

    def F(z):
        yz = y(z)
        return (yz / stumpff_c(z)) ** 1.5 * stumpff_s(z) + A * np.sqrt(yz) - np.sqrt(mu) * tof

    # Recherche d'un intervalle ou F change de signe (une seule revolution)
    zs = np.linspace(-100, 4 * np.pi ** 2 - 1e-6, 4000)
    valides = [z for z in zs if y(z) > 0]
    vals = [F(z) for z in valides]
    for i in range(len(vals) - 1):
        if np.sign(vals[i]) != np.sign(vals[i + 1]):
            z = brentq(F, valides[i], valides[i + 1])
            break
    else:
        raise RuntimeError("Lambert : pas de solution pour cette duree de transfert")

    yz = y(z)
    f = 1 - yz / n1
    g = A * np.sqrt(yz / mu)
    gdot = 1 - yz / n2
    v1 = (r2 - f * r1) / g
    v2 = (gdot * r2 - r1) / g
    return v1, v2


# ============================================
# 4. CALCUL DE LA TRAJECTOIRE
# ============================================

def rotation(vec, axe, angle):
    """Rotation de vec autour de axe (formule de Rodrigues)."""
    k = axe / np.linalg.norm(axe)
    return (vec * np.cos(angle) + np.cross(k, vec) * np.sin(angle)
            + k * np.dot(k, vec) * (1 - np.cos(angle)))


def calculer_transfert(obspos_me, et_dep, et_arr, alt_leo_km=200.0, angle_transfert_deg=170.0):
    # Point vise a l'arrivee (site, ou point au-dessus du site)
    cible = site_en_j2000(obspos_me, et_arr)

    # Plan de l'orbite lunaire, pour placer le depart dans ce plan
    r_l, v_l = etat_lune(et_arr)
    normale = np.cross(r_l, v_l)

    # Point de depart sur l'orbite basse, a angle_transfert_deg "avant" la cible
    u_cible = cible / np.linalg.norm(cible)
    r0 = (R_EARTH + alt_leo_km) * rotation(u_cible, normale, -np.radians(angle_transfert_deg))
    # on remet r0 dans le plan perpendiculaire a la normale
    r0 -= np.dot(r0, normale) / np.dot(normale, normale) * normale
    r0 *= (R_EARTH + alt_leo_km) / np.linalg.norm(r0)

    # Estimation initiale : Lambert sans la Lune ni le Soleil
    v0_guess, _ = lambert(r0, cible, et_arr - et_dep, GM_EARTH, normale)

    # Correction : on ajuste v0 pour que la trajectoire complete
    # (Terre + Lune + Soleil) arrive exactement sur la cible.
    def ecart(v0):
        sol = propager(np.concatenate([r0, v0]), et_dep, et_arr)
        return sol.y[:3, -1] - cible

    v0, info, ier, msg = fsolve(ecart, v0_guess, full_output=True, xtol=1e-12)
    erreur = np.linalg.norm(ecart(v0))
    if erreur > 1.0:
        raise RuntimeError(f"La correction n'a pas converge (ecart {erreur:.1f} km) : {msg}")

    return r0, v0, normale, erreur


def angles_site(target, et, obspos_me):
    """Azimut / elevation d'un astre vu du site (methode azlcpo du code 1)."""
    azel, _ = sp.azlcpo("ELLIPSOID", target, et, "CN+S", False, True,
                        obspos_me, "MOON", "MOON_ME")
    return np.degrees(azel[1]) % 360, np.degrees(azel[2])


# ============================================
# 5. PROGRAMME PRINCIPAL
# ============================================

def lire_nombre(message, defaut):
    valeur = input(f"{message} [{defaut}] : ").strip()
    return float(valeur.replace(",", ".")) if valeur else float(defaut)


def main():
    charger_kernels()
    try:
        print("\n========== LUNAR MISSION : TRAJECTOIRE ==========")

        print("\n--- POINT LUNAIRE ---")
        latitude = lire_nombre("Latitude (degres, Sud negatif)", -85)
        longitude = lire_nombre("Longitude (degres, Ouest negatif)", -30)
        altitude_km = lire_nombre("Altitude du point vise (km)", 1.5)

        print("\n--- DATES ---")
        date_dep = input("Date de depart UTC [2027 JAN 01 00:00:00 UTC] : ").strip() \
            or "2027 JAN 01 00:00:00 UTC"
        duree_j = lire_nombre("Duree du transfert (jours)", 4.5)
        alt_leo = lire_nombre("Altitude de l'orbite de depart (km)", 200)

        et_dep = sp.str2et(date_dep)
        et_arr = et_dep + duree_j * 86400
        print(f"Arrivee : {sp.et2utc(et_arr, 'C', 0)} UTC")

        obspos = position_site_moon_me(latitude, longitude, altitude_km)

        print("\nCalcul de la trajectoire (quelques secondes)...")
        r0, v0, normale, erreur = calculer_transfert(obspos, et_dep, et_arr, alt_leo)

        sol = propager(np.concatenate([r0, v0]), et_dep, et_arr, n_points=1000)

        # Delta-v au depart (par rapport a l'orbite circulaire basse)
        v_circ = np.sqrt(GM_EARTH / np.linalg.norm(r0)) * \
            np.cross(normale, r0) / np.linalg.norm(np.cross(normale, r0))
        dv_dep = np.linalg.norm(v0 - v_circ)

        # Vitesse a l'arrivee par rapport au site (repere MOON_ME, rotation incluse)
        etat_final = sol.y[:, -1]
        etat_lune_arr, _ = sp.spkezr("MOON", et_arr, "J2000", "NONE", "EARTH")
        rel_j2000 = etat_final - np.array(etat_lune_arr)
        xf = np.array(sp.sxform("J2000", "MOON_ME", et_arr))
        v_rel_site = np.linalg.norm((xf @ rel_j2000)[3:])

        print("\n--- RESULTATS ---")
        print(f"Ecart final sur la cible : {erreur * 1000:.1f} m")
        print(f"Vitesse au depart        : {np.linalg.norm(v0):.4f} km/s")
        print(f"Delta-v d'injection      : {dv_dep:.4f} km/s")
        print(f"Vitesse a l'arrivee (par rapport au sol lunaire) : {v_rel_site:.4f} km/s")
        print("  -> c'est le delta-v de freinage a fournir pour se poser.")

        if sol.t_events[0].size > 1 or (sol.t_events[0].size == 1
                                        and sol.t_events[0][0] < et_arr - 60):
            print("ATTENTION : la trajectoire traverse la Lune avant d'arriver au site.")
            print("            Essaie une autre duree ou un autre angle de transfert.")

        print("\n--- CONDITIONS AU SITE A L'ARRIVEE ---")
        for target in ["SUN", "EARTH"]:
            az, el = angles_site(target, et_arr, obspos)
            visible = "visible" if el > 0 else "sous l'horizon"
            print(f"{target:5s} : azimut {az:8.3f} deg, elevation {el:7.3f} deg ({visible})")

        # Export CSV : date + vecteurs d'etat
        fichier = Path(__file__).resolve().parent / "trajectoire.csv"
        with open(fichier, "w", newline="") as f:
            w = csv.writer(f, delimiter=";")
            w.writerow(["date_utc", "x_km", "y_km", "z_km", "vx_kms", "vy_kms", "vz_kms",
                        "dist_terre_km", "dist_lune_km"])
            for t, s in zip(sol.t, sol.y.T):
                r_l, _ = etat_lune(t)
                w.writerow([sp.et2utc(t, "ISOC", 0), *np.round(s, 6),
                            round(np.linalg.norm(s[:3]), 3),
                            round(np.linalg.norm(s[:3] - r_l), 3)])
        print(f"\nTrajectoire exportee : {fichier}")
        print("(repere J2000 centre Terre, km et km/s)")

    finally:
        sp.kclear()


if __name__ == "__main__":
    main()
    