import React from 'react';
import { NavLink, Outlet, Link } from 'react-router-dom';
import { LayoutDashboard, Users, Shirt, Activity, BarChart3, Settings, Bell, LogOut, ArrowDownCircle, UploadCloud } from 'lucide-react';
import { cn } from '../lib/utils';

const SidebarItem = ({ to, icon: Icon, label }) => (
    <NavLink
        to={to}
        className={({ isActive }) =>
            cn(
                "flex items-center gap-3 rounded-lg px-3 py-2 text-muted-foreground transition-all hover:text-primary",
                isActive && "bg-muted text-primary"
            )
        }
    >
        <Icon className="h-4 w-4" />
        {label}
    </NavLink>
);

const Layout = ({ onLogout }) => {
    return (
        <div className="grid min-h-screen w-full md:grid-cols-[220px_1fr] lg:grid-cols-[280px_1fr]">
            <div className="hidden border-r bg-muted/40 md:block">
                <div className="flex h-full max-h-screen flex-col gap-2">
                    <div className="flex h-14 items-center border-b px-4 lg:h-[60px] lg:px-6">
                        <a href="/" className="flex items-center gap-2 font-semibold">
                            <Activity className="h-6 w-6 text-primary" />
                            <span className="whitespace-nowrap">Entrance Analysis System</span>
                        </a>

                    </div>
                    <div className="flex-1">
                        <nav className="grid items-start px-2 text-sm font-medium lg:px-4">
                            <SidebarItem to="/" icon={LayoutDashboard} label="Main Monitoring" />
                            <SidebarItem to="/people-counting" icon={Users} label="People Counting Rules" />
                            <SidebarItem to="/dress-code" icon={Shirt} label="Dress Code Policy" />
                            <SidebarItem to="/fall-detection" icon={ArrowDownCircle} label="Fall Detection" />
                            <SidebarItem to="/reports" icon={BarChart3} label="Reporting" />
                            <SidebarItem to="/upload" icon={UploadCloud} label="Video Analysis Upload" />
                            <SidebarItem to="/settings" icon={Settings} label="System Configuration" />
                        </nav>
                    </div>
                    <div className="mt-auto p-4">
                    </div>
                </div>
            </div>
            <div className="flex flex-col">
                <header className="flex h-14 items-center gap-4 border-b bg-muted/40 px-4 lg:h-[60px] lg:px-6">
                    <div className="w-full flex-1">
                        <form>
                            <div className="relative">
                                {/* Search placeholder */}
                            </div>
                        </form>
                    </div>
                    <div className="flex items-center gap-4">
                        <button className="h-8 w-8 rounded-full border bg-background p-0 text-muted-foreground hover:text-foreground">
                            <Bell className="h-4 w-4 mx-auto" />
                            <span className="sr-only">Toggle notifications</span>
                        </button>
                        <Link to="/account" className="h-8 w-8 rounded-full bg-primary/20 flex items-center justify-center text-primary font-bold hover:bg-primary/30 transition-colors">
                            A
                        </Link>
                        <button onClick={onLogout} className="h-8 w-8 rounded-full border bg-background p-0 text-muted-foreground hover:text-foreground" title="Logout">
                            <LogOut className="h-4 w-4 mx-auto" />
                            <span className="sr-only">Logout</span>
                        </button>
                    </div>
                </header>
                <main className="flex flex-1 flex-col gap-4 p-4 lg:gap-6 lg:p-6 bg-background">
                    <Outlet />
                </main>
            </div>
        </div>
    );
};

export default Layout;
